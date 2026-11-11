<?php
// Endpoints del complemento de Revit: /api/v1/{activate,validate,deactivate,release,health}
declare(strict_types=1);

const XP_MAX_BAD_ATTEMPTS_PER_HOUR = 20;
const XP_MAX_SELF_RELEASES_PER_30_DAYS = 3;

function xp_route_license(string $method, string $action): void
{
    if ($action === 'health') {
        xp_json(200, ['ok' => true]);
    }
    if ($method !== 'POST') {
        xp_fail(405, 'method_not_allowed', 'Método no permitido.');
    }
    switch ($action) {
        case 'activate':
            xp_lic_handle(true);
            break;
        case 'validate':
            xp_lic_handle(false);
            break;
        case 'deactivate':
            xp_lic_deactivate();
            break;
        case 'release':
            xp_lic_release();
            break;
        case 'export':
            xp_lic_export();
            break;
    }
}

function xp_device_info(array $body): array
{
    $hash = is_string($body['deviceId'] ?? null) ? strtolower($body['deviceId']) : '';
    return [
        'hash' => preg_match('/^[0-9a-f]{64}$/', $hash) ? $hash : '',
        'name' => xp_clip($body['deviceName'] ?? null, 80),
        'revit' => xp_clip($body['revitVersion'] ?? null, 16),
        'app' => xp_clip($body['appVersion'] ?? null, 16),
    ];
}

/** Key lookup plus state checks. Exits with an error response when the licence cannot be used. */
function xp_resolve_license(array $body, string $ip): array
{
    if ($ip !== '') {
        $row = xp_one("SELECT COUNT(*) AS n FROM events WHERE type = 'bad_key' AND ip = ? AND created_at > ?", [$ip, time() - 3600]);
        if ((int) $row['n'] >= XP_MAX_BAD_ATTEMPTS_PER_HOUR) {
            xp_fail(429, 'rate_limited', 'Demasiados intentos. Inténtelo de nuevo más tarde.');
        }
    }
    $key = xp_normalize_key($body['key'] ?? null);
    $lic = $key ? xp_one('SELECT * FROM licenses WHERE key_hash = ?', [xp_sha256($key)]) : null;
    if (!$lic) {
        xp_log_event('bad_key', null, null, $key ? 'unknown key' : 'malformed key', $ip);
        xp_fail(404, 'invalid_key', 'La clave de licencia no es válida.');
    }
    if ($lic['status'] === 'revoked') {
        xp_fail(403, 'revoked', 'Esta licencia fue revocada. Contacte a su proveedor.');
    }
    if ($lic['status'] === 'suspended') {
        xp_fail(403, 'suspended', 'Esta licencia está suspendida. Contacte a su proveedor.');
    }
    if ((int) $lic['expires_at'] <= time()) {
        xp_fail(403, 'expired', 'La licencia ha vencido. Renuévela para seguir usando XportBIM.', ['expiresAt' => (int) $lic['expires_at']]);
    }
    if (!empty($lic['is_trial']) && version_compare((string) ($body['appVersion'] ?? '0'), '3.2.0', '<')) {
        // Los clientes antiguos solo descartan un token si reconocen el código de rechazo.
        xp_fail(426, 'expired', 'Actualiza BIM FLOW a la versión 3.2.0 o posterior para usar el mes gratuito con una exportación diaria.', ['reason' => 'update_required']);
    }
    return $lic;
}

function xp_issue(array $lic, string $deviceHash, int $devicesUsed): void
{
    $grace = (int) (xp_config()['offline_grace_days'] ?? 7);
    $grace = min(30, max(1, $grace));
    $iat = time();
    $exp = (int) $lic['expires_at'];
    xp_json(200, [
        'ok' => true,
        'token' => xp_sign_token([
            'v' => 1,
            'lid' => $lic['id'],
            'dev' => $deviceHash,
            'name' => $lic['customer_name'],
            'plan' => $lic['plan'],
            'exp' => $exp,
            'iat' => $iat,
            'chk' => min($exp, $iat + $grace * XP_DAY),
            'dailyLimit' => !empty($lic['is_trial']) ? 1 : 0,
        ]),
        'license' => [
            'customer' => $lic['customer_name'],
            'plan' => $lic['plan'],
            'expiresAt' => $exp,
            'maxDevices' => (int) $lic['max_devices'],
            'devicesUsed' => $devicesUsed,
        ],
        'serverTime' => $iat,
    ]);
}

function xp_usage_day(): string
{
    return (new DateTimeImmutable('now', new DateTimeZone('America/Lima')))->format('Y-m-d');
}

function xp_usage_reset(): int
{
    return (new DateTimeImmutable('tomorrow', new DateTimeZone('America/Lima')))->getTimestamp();
}

/** Una exportación es un lote confirmado; reintentar sus fallos dentro del mismo lote no vuelve a consumir cupo. */
function xp_lic_export(): void
{
    $b = xp_body() ?? [];
    $lic = xp_resolve_license($b, xp_ip());
    $dev = xp_device_info($b);
    $requestId = xp_clip($b['requestId'] ?? '', 36);
    if ($dev['hash'] === '' || !preg_match('/^[a-f0-9-]{36}$/i', $requestId)) { xp_fail(400, 'bad_request', 'Solicitud de exportación inválida.'); }
    $outcome = xp_tx(function () use ($lic, $dev, $requestId) {
        $current = xp_one('SELECT * FROM licenses WHERE id = ?' . xp_for_update(), [$lic['id']]);
        if (!$current || $current['status'] !== 'active' || (int) $current['expires_at'] <= time()) { return 'expired'; }
        if (!xp_one("SELECT id FROM devices WHERE license_id = ? AND device_hash = ? AND status = 'active'", [$lic['id'], $dev['hash']])) { return 'device_not_activated'; }
        if (empty($current['is_trial'])) { return 'ok'; }
        $day = xp_usage_day();
        $used = xp_one('SELECT * FROM export_usage WHERE (license_id = ? OR device_hash = ?) AND usage_day = ?', [$lic['id'], $dev['hash'], $day]);
        if ($used) { return $used['license_id'] === $lic['id'] && $used['device_hash'] === $dev['hash'] && $used['request_id'] === $requestId ? 'ok' : 'daily_limit'; }
        try {
            xp_exec('INSERT INTO export_usage (license_id, usage_day, device_hash, request_id, created_at) VALUES (?, ?, ?, ?, ?)', [$lic['id'], $day, $dev['hash'], $requestId, time()]);
        } catch (PDOException $e) {
            if (substr((string) $e->getCode(), 0, 2) !== '23') { throw $e; }
            return 'daily_limit';
        }
        xp_log_event('free_export_reserved', $lic['id'], null, $requestId, xp_ip());
        return 'ok';
    });
    if ($outcome === 'daily_limit') { xp_fail(429, 'daily_limit', 'Ya utilizaste tu exportación gratuita de hoy. Vuelve mañana o elige un plan sin límite diario.', ['resetsAt' => xp_usage_reset()]); }
    if ($outcome !== 'ok') { xp_fail(403, $outcome, 'La licencia o este equipo ya no están activos. Verifica tu licencia.'); }
    xp_json(200, ['ok' => true]);
}

function xp_lic_handle(bool $allowNew): void
{
    $ip = xp_ip();
    $body = xp_body();
    if (!$body) {
        xp_fail(400, 'bad_request', 'Solicitud inválida.');
    }
    $dev = xp_device_info($body);
    if ($dev['hash'] === '') {
        xp_fail(400, 'bad_request', 'Identificador de equipo inválido.');
    }
    $lic = xp_resolve_license($body, $ip);
    $t = time();

    // The licence row is locked so two simultaneous activations cannot both take the last slot.
    $outcome = xp_tx(function () use ($lic, $dev, $allowNew, $ip, $t) {
        xp_one('SELECT id FROM licenses WHERE id = ?' . xp_for_update(), [$lic['id']]);
        $device = xp_one('SELECT * FROM devices WHERE license_id = ? AND device_hash = ?', [$lic['id'], $dev['hash']]);

        if ($device && $device['status'] === 'active') {
            xp_exec(
                'UPDATE devices SET last_seen = ?, device_name = ?, revit_version = ?, app_version = ? WHERE id = ?',
                [$t, $dev['name'] ?: $device['device_name'], $dev['revit'] ?: $device['revit_version'], $dev['app'] ?: $device['app_version'], $device['id']]
            );
        } else {
            if (!$allowNew) {
                return ['fail' => [409, 'device_not_activated', 'Este equipo no está activado para la licencia. Actívelo de nuevo.', []]];
            }
            // Una prueba gratuita por equipo: un equipo que ya activó la prueba de otra cuenta no puede reutilizarla.
            $seenTrial = null;
            if (!empty($lic['is_trial'])) {
                $seenTrial = xp_one('SELECT license_id FROM trial_devices WHERE device_hash = ?', [$dev['hash']]);
                if ($seenTrial && $seenTrial['license_id'] !== $lic['id']) {
                    xp_log_event('trial_reused', $lic['id'], null, $dev['name'], $ip);
                    return ['fail' => [403, 'trial_used', 'Este equipo ya usó una prueba gratuita. Compre una licencia para continuar.', []]];
                }
            }
            $active = xp_all(
                "SELECT id, device_name, last_seen FROM devices WHERE license_id = ? AND status = 'active' ORDER BY last_seen DESC",
                [$lic['id']]
            );
            if (count($active) >= (int) $lic['max_devices']) {
                xp_log_event('device_limit', $lic['id'], null, $dev['name'], $ip);
                $list = [];
                foreach ($active as $d) {
                    $list[] = ['ref' => $d['id'], 'name' => $d['device_name'], 'lastSeen' => (int) $d['last_seen']];
                }
                return ['fail' => [409, 'device_limit', 'La licencia ya está activada en ' . (int) $lic['max_devices'] . ' equipo(s). Libere uno para continuar.', ['devices' => $list]]];
            }
            if ($device) {
                xp_exec(
                    "UPDATE devices SET status = 'active', released_at = NULL, last_seen = ?, device_name = ?, revit_version = ?, app_version = ? WHERE id = ?",
                    [$t, $dev['name'], $dev['revit'], $dev['app'], $device['id']]
                );
                $deviceId = $device['id'];
            } else {
                $deviceId = xp_uuid();
                xp_exec(
                    "INSERT INTO devices (id, license_id, device_hash, device_name, revit_version, app_version, status, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)",
                    [$deviceId, $lic['id'], $dev['hash'], $dev['name'], $dev['revit'], $dev['app'], $t, $t]
                );
            }
            if (!empty($lic['is_trial']) && !$seenTrial) {
                try {
                    xp_exec('INSERT INTO trial_devices (device_hash, license_id, first_at) VALUES (?, ?, ?)', [$dev['hash'], $lic['id'], $t]);
                } catch (PDOException $e) {
                    // Otra activación simultánea ya registró este equipo: se ignora.
                }
            }
            xp_log_event('activated', $lic['id'], $deviceId, $dev['name'] . ' · Revit ' . $dev['revit'] . ' · v' . $dev['app'], $ip);
        }
        $count = xp_one("SELECT COUNT(*) AS n FROM devices WHERE license_id = ? AND status = 'active'", [$lic['id']]);
        return ['count' => (int) $count['n']];
    });

    if (isset($outcome['fail'])) {
        [$status, $code, $message, $extra] = $outcome['fail'];
        xp_fail($status, $code, $message, $extra);
    }
    xp_issue($lic, $dev['hash'], max(1, $outcome['count']));
}

/** The device releases its own slot (e.g. the user is moving to another PC). */
function xp_lic_deactivate(): void
{
    $ip = xp_ip();
    $body = xp_body();
    if (!$body) {
        xp_fail(400, 'bad_request', 'Solicitud inválida.');
    }
    $dev = xp_device_info($body);
    if ($dev['hash'] === '') {
        xp_fail(400, 'bad_request', 'Identificador de equipo inválido.');
    }
    $key = xp_normalize_key($body['key'] ?? null);
    $lic = $key ? xp_one('SELECT id FROM licenses WHERE key_hash = ?', [xp_sha256($key)]) : null;
    if (!$lic) {
        xp_fail(404, 'invalid_key', 'La clave de licencia no es válida.');
    }
    $device = xp_one("SELECT id FROM devices WHERE license_id = ? AND device_hash = ? AND status = 'active'", [$lic['id'], $dev['hash']]);
    if ($device) {
        xp_exec("UPDATE devices SET status = 'released', released_at = ? WHERE id = ?", [time(), $device['id']]);
        xp_log_event('released_by_device', $lic['id'], $device['id'], '', $ip);
    }
    xp_json(200, ['ok' => true]);
}

/** Frees another device's slot knowing only the key (limited to a few per 30 days). */
function xp_lic_release(): void
{
    $ip = xp_ip();
    $body = xp_body();
    if (!$body) {
        xp_fail(400, 'bad_request', 'Solicitud inválida.');
    }
    $lic = xp_resolve_license($body, $ip);
    $ref = xp_clip($body['ref'] ?? null, 64);
    $used = xp_one(
        "SELECT COUNT(*) AS n FROM events WHERE license_id = ? AND type = 'released_self_service' AND created_at > ?",
        [$lic['id'], time() - 30 * XP_DAY]
    );
    if ((int) $used['n'] >= XP_MAX_SELF_RELEASES_PER_30_DAYS) {
        xp_fail(429, 'release_limit', 'Se alcanzó el límite de liberaciones. Contacte a su proveedor.');
    }
    $device = xp_one("SELECT id, device_name FROM devices WHERE id = ? AND license_id = ? AND status = 'active'", [$ref, $lic['id']]);
    if (!$device) {
        xp_fail(404, 'unknown_device', 'No se encontró ese equipo.');
    }
    xp_exec("UPDATE devices SET status = 'released', released_at = ? WHERE id = ?", [time(), $device['id']]);
    xp_log_event('released_self_service', $lic['id'], $device['id'], $device['device_name'], $ip);
    xp_json(200, ['ok' => true]);
}
