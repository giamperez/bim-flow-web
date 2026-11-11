<?php
declare(strict_types=1);

function xp_monthly_period(): string { return (new DateTimeImmutable('now', new DateTimeZone('America/Lima')))->format('Y-m'); }
function xp_monthly_reset(): int { return (new DateTimeImmutable('first day of next month 00:00:00', new DateTimeZone('America/Lima')))->getTimestamp(); }
function xp_monthly_usage(string $licenseId): int {
    return (int) (xp_one('SELECT used_units FROM export_buckets WHERE subject = ? AND period = ?', ['license:' . $licenseId, xp_monthly_period()])['used_units'] ?? 0);
}

/** La prueba full termina en el plan gratuito, conservando clave y estado administrativo. */
function xp_refresh_access(array $lic): array
{
    $mode = $lic['access_mode'] ?? 'paid';
    if ((int) $lic['expires_at'] > time() || $lic['status'] !== 'active' || ($mode !== 'trial' && ($mode !== 'paid' || empty($lic['customer_id'])))) { return $lic; }
    $refresh = function () use ($lic) {
        $current = xp_one('SELECT * FROM licenses WHERE id = ?' . xp_for_update(), [$lic['id']]);
        if (!$current || (int) $current['expires_at'] > time() || $current['status'] !== 'active') { return $current ?: $lic; }
        xp_exec("UPDATE licenses SET access_mode = 'free', is_trial = 0, plan = 'Gratuito', max_devices = 1, expires_at = 253402300799, updated_at = ? WHERE id = ?", [time(), $lic['id']]);
        $active = xp_all("SELECT id FROM devices WHERE license_id = ? AND status = 'active' ORDER BY last_seen DESC, id", [$lic['id']]);
        foreach (array_slice($active, 1) as $device) { xp_exec("UPDATE devices SET status = 'released', released_at = ? WHERE id = ?", [time(), $device['id']]); }
        return xp_one('SELECT * FROM licenses WHERE id = ?', [$lic['id']]);
    };
    return xp_db()->inTransaction() ? $refresh() : xp_tx($refresh);
}

function xp_portal_start_trial(array $customer): void
{
    if (xp_verification_required() && empty($customer['email_verified_at'])) { xp_json(403, ['ok' => false, 'error' => 'Confirma tu correo para probar Xport Full.']); }
    xp_ensure_free_license($customer);
    $started = xp_tx(function () use ($customer) {
        $fresh = xp_one('SELECT * FROM customers WHERE id = ?' . xp_for_update(), [$customer['id']]);
        if (!xp_trial_available($fresh)) { return false; }
        $lic = xp_portal_license_row($fresh);
        if (!$lic) { return false; }
        $devices = xp_all("SELECT device_hash FROM devices WHERE license_id = ? AND status = 'active'", [$lic['id']]);
        foreach ($devices as $device) {
            $used = xp_one('SELECT license_id FROM trial_devices WHERE device_hash = ?', [$device['device_hash']]);
            if ($used && $used['license_id'] !== $lic['id']) { return false; }
            if (!$used) {
                try { xp_exec('INSERT INTO trial_devices (device_hash, license_id, first_at) VALUES (?, ?, ?)', [$device['device_hash'], $lic['id'], time()]); }
                catch (PDOException $e) { if (substr((string) $e->getCode(), 0, 2) === '23') return false; throw $e; }
            }
        }
        xp_exec('UPDATE customers SET trial_started_at = ? WHERE id = ?', [time(), $customer['id']]);
        xp_exec("UPDATE licenses SET access_mode = 'trial', is_trial = 1, plan = 'Full · prueba 14 días', expires_at = ?, updated_at = ? WHERE id = ?", [time() + 14 * XP_DAY, time(), $lic['id']]);
        xp_log_event('full_trial_started', $lic['id'], null, '14 días · sin tarjeta');
        return true;
    });
    xp_json($started ? 200 : 409, $started ? ['ok' => true] : ['ok' => false, 'error' => 'La prueba full ya no está disponible para esta cuenta o computadora.']);
}

/** Reserva archivos previstos. Al finalizar, solo los archivos principales exitosos consumen cupo. */
function xp_lic_export(): void
{
    $b = xp_body() ?? [];
    $lic = xp_resolve_license($b, xp_ip());
    $dev = xp_device_info($b);
    $request = xp_clip($b['requestId'] ?? '', 36);
    $units = $b['units'] ?? (($lic['access_mode'] ?? 'paid') === 'paid' ? 1 : null);
    if ($dev['hash'] === '' || !preg_match('/^[a-f0-9-]{36}$/i', $request) || !is_int($units) || $units < 1 || $units > 100000) { xp_fail(400, 'bad_request', 'Cantidad de archivos o solicitud inválida.'); }
    $result = xp_tx(function () use ($lic, $dev, $request, $units, $b) {
        $current = xp_one('SELECT * FROM licenses WHERE id = ?' . xp_for_update(), [$lic['id']]);
        if (!$current) { return 'expired'; }
        $current = xp_refresh_access($current);
        if ($current['status'] !== 'active' || (int) $current['expires_at'] <= time()) { return 'expired'; }
        if (!xp_one("SELECT id FROM devices WHERE license_id = ? AND device_hash = ? AND status = 'active'", [$lic['id'], $dev['hash']])) { return 'device_not_activated'; }
        $free = $current['access_mode'] === 'free';
        if ($free && ($b['requiresFull'] ?? true) !== false) { return 'full_required'; }
        if ($current['access_mode'] === 'trial') {
            $used = xp_one('SELECT license_id FROM trial_devices WHERE device_hash = ?', [$dev['hash']]);
            if ($used && $used['license_id'] !== $lic['id']) { return 'trial_used'; }
            if (!$used) { xp_exec('INSERT INTO trial_devices (device_hash, license_id, first_at) VALUES (?, ?, ?)', [$dev['hash'], $lic['id'], time()]); }
        }
        if (!$free) { return 'ok'; }
        $existing = xp_one('SELECT * FROM export_reservations WHERE license_id = ? AND request_id = ?', [$lic['id'], $request]);
        if ($existing) {
            return $existing['device_hash'] === $dev['hash'] && (int) $existing['planned_units'] === $units && $existing['settled_at'] === null ? 'ok' : 'request_conflict';
        }
        $period = xp_monthly_period();
        if ($free) {
            $subjects = ['license:' . $lic['id'], 'device:' . $dev['hash']]; sort($subjects);
            foreach ($subjects as $subject) {
                xp_exec((xp_is_sqlite() ? 'INSERT OR IGNORE' : 'INSERT IGNORE') . ' INTO export_buckets (subject, period, used_units) VALUES (?, ?, 0)', [$subject, $period]);
                $bucket = xp_one('SELECT used_units FROM export_buckets WHERE subject = ? AND period = ?' . xp_for_update(), [$subject, $period]);
                if ((int) $bucket['used_units'] + $units > 150) { return 'monthly_limit'; }
            }
            foreach ($subjects as $subject) { xp_exec('UPDATE export_buckets SET used_units = used_units + ? WHERE subject = ? AND period = ?', [$units, $subject, $period]); }
        }
        xp_exec('INSERT INTO export_reservations (license_id, request_id, device_hash, period, planned_units, quota_units, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [$lic['id'], $request, $dev['hash'], $period, $units, $free ? $units : 0, time()]);
        return 'ok';
    });
    $messages = ['monthly_limit' => 'No queda suficiente cupo para este lote. Xport Gratuito permite 150 archivos al mes. Reduce la selección o elige un plan Full.',
        'full_required' => 'Esta configuración requiere Xport Full. Tu prueba puede haber terminado: abre de nuevo el exportador para usar las opciones gratuitas.',
        'trial_used' => 'Esta computadora ya utilizó una prueba full con otra cuenta.', 'request_conflict' => 'Este lote ya terminó o la solicitud cambió. Crea un lote nuevo.'];
    if ($result !== 'ok') { xp_fail($result === 'monthly_limit' ? 429 : 403, $result, $messages[$result] ?? 'La licencia o este equipo ya no están activos.', ['resetsAt' => xp_monthly_reset()]); }
    xp_json(200, ['ok' => true]);
}

function xp_lic_export_complete(): void
{
    $b = xp_body() ?? [];
    // La conciliación de un lote ya autorizado debe funcionar incluso si la licencia vence durante la exportación.
    $key = xp_normalize_key($b['key'] ?? null);
    $lic = $key ? xp_one('SELECT * FROM licenses WHERE key_hash = ?', [xp_sha256($key)]) : null;
    $dev = xp_device_info($b);
    $request = xp_clip($b['requestId'] ?? '', 36);
    $actual = $b['units'] ?? null;
    if (!$lic || $dev['hash'] === '' || !is_int($actual) || $actual < 0) { xp_fail(400, 'bad_request', 'Conciliación inválida.'); }
    $result = xp_tx(function () use ($lic, $dev, $request, $actual) {
        $row = xp_one('SELECT * FROM export_reservations WHERE license_id = ? AND request_id = ?' . xp_for_update(), [$lic['id'], $request]);
        if (!$row || $row['device_hash'] !== $dev['hash'] || $actual > (int) $row['planned_units']) { return false; }
        if ($row['settled_at'] !== null) { return (int) $row['actual_units'] === $actual; }
        $refund = (int) $row['quota_units'] > 0 ? (int) $row['planned_units'] - $actual : 0;
        foreach (['device:' . $dev['hash'], 'license:' . $lic['id']] as $subject) {
            if ($refund) { xp_exec('UPDATE export_buckets SET used_units = used_units - ? WHERE subject = ? AND period = ?', [$refund, $subject, $row['period']]); }
        }
        xp_exec('UPDATE export_reservations SET actual_units = ?, settled_at = ? WHERE license_id = ? AND request_id = ?', [$actual, time(), $lic['id'], $request]);
        return true;
    });
    if (!$result) { xp_fail(409, 'request_conflict', 'El lote no corresponde a esta computadora o ya fue conciliado con otro resultado.'); }
    xp_json(200, ['ok' => true]);
}
