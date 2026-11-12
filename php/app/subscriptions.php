<?php
declare(strict_types=1);

/**
 * Suscripción: un cliente tiene un plan de pago vigente que puede subir (al instante, cobrando solo la diferencia del
 * período que queda), bajar (al terminar el período) y, si lo autoriza, renovarse solo con una tarjeta guardada.
 *
 * Reglas:
 *  - Subir de categoría (más computadoras, mismo ciclo): inmediato. Se cobra (precio nuevo − precio actual) × tiempo restante
 *    ÷ duración del ciclo. La fecha de renovación no cambia. Diferencias menores al mínimo de cobro no se cobran.
 *  - Bajar de categoría o cambiar de ciclo (mensual ↔ anual): se programa para el final del período, sin cobro ni reembolso.
 *  - Renovación automática solo con consentimiento expreso, revocable en cualquier momento. Se avisa 3 días antes.
 *    Si el cobro falla se reintenta cada día durante 3 días (el acceso continúa) y luego la renovación se cancela.
 *  - Un cobro con respuesta ambigua NUNCA se reintenta: queda en revisión para no cobrar dos veces.
 */
const XP_CONSENT_VERSION = 'v1';
const XP_GRACE_DAYS = 3;
const XP_MAX_ATTEMPTS = 4;          // intento inicial + 3 reintentos diarios
const XP_RETRY_SECONDS = 86400;
const XP_NOTICE_DAYS = 3;
const XP_MIN_CHARGE_CENTS = 300;    // por debajo de este importe la diferencia de un cambio de plan no se cobra

function xp_plan_by_id(string $id): ?array
{
    foreach (xp_plans() as $plan) {
        if ($plan['id'] === $id) { return $plan; }
    }
    return null;
}

function xp_date_es(int $ts): string
{
    return (new DateTimeImmutable('@' . $ts))->setTimezone(new DateTimeZone('America/Lima'))->format('d/m/Y');
}

/** Suscripción del cliente. Si solo existe una licencia de pago comprada antes de este modelo, se adopta a partir de su último pedido. */
function xp_sub_for(array $customer): ?array
{
    $sub = xp_one('SELECT * FROM subscriptions WHERE customer_id = ?', [$customer['id']]);
    if ($sub) { return $sub; }
    $lic = xp_portal_license_row($customer);
    if (!$lic || ($lic['access_mode'] ?? 'paid') !== 'paid' || $lic['status'] !== 'active' || (int) $lic['expires_at'] <= time()) { return null; }
    $order = xp_one("SELECT plan_id, plan_name FROM orders WHERE customer_id = ? AND status = 'paid' AND amount_cents > 0 ORDER BY paid_at DESC LIMIT 1", [$customer['id']]);
    $plan = $order ? xp_plan_by_id($order['plan_id']) : null;
    if (!$plan || $plan['free'] || $plan['name'] !== $lic['plan']) { return null; }
    $now = time();
    try {
        xp_exec('INSERT INTO subscriptions (id, customer_id, license_id, plan_id, status, period_end, auto_renew, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
            [xp_uuid(), $customer['id'], $lic['id'], $plan['id'], 'active', (int) $lic['expires_at'], $now, $now]);
    } catch (PDOException $e) {
        if (substr((string) $e->getCode(), 0, 2) !== '23') { throw $e; }
    }
    return xp_one('SELECT * FROM subscriptions WHERE customer_id = ?', [$customer['id']]);
}

/** El plan de pago está vigente (no vencido ni cancelado). */
function xp_sub_is_live(?array $sub, ?int $now = null): bool
{
    $now ??= time();
    return $sub !== null && $sub['status'] !== 'canceled' && ((int) $sub['period_end'] > $now || in_array($sub['status'], ['past_due', 'review'], true));
}

/**
 * Cuánto cuesta subir al plan $target ahora. null si no es una subida inmediata (misma o menor categoría, otro ciclo,
 * cobro pendiente, o período vencido).
 *
 * @return array{amountCents:int,fullDiffCents:int,remaining:int,waived:bool}|null
 */
function xp_upgrade_quote(array $sub, array $target, ?int $now = null): ?array
{
    $now ??= time();
    $current = xp_plan_by_id($sub['plan_id']);
    if (!$current || $current['free'] || $target['free'] || $sub['status'] !== 'active') { return null; }
    if ($target['cycle'] !== $current['cycle'] || $target['devices'] <= $current['devices']) { return null; }
    $remaining = min((int) $sub['period_end'] - $now, (int) $current['seconds']);
    if ($remaining <= 0) { return null; }
    $diff = (int) round(($target['priceCents'] - $current['priceCents']) * $remaining / $current['seconds']);
    $waived = $diff < XP_MIN_CHARGE_CENTS;
    return ['amountCents' => $waived ? 0 : $diff, 'fullDiffCents' => $diff, 'remaining' => $remaining, 'waived' => $waived];
}

/** Qué significa elegir $target para quien ya tiene suscripción: 'same' | 'upgrade' | 'schedule'. */
function xp_plan_change_kind(array $sub, array $target): string
{
    if ($sub['plan_id'] === $target['id']) { return 'same'; }
    return xp_upgrade_quote($sub, $target) !== null ? 'upgrade' : 'schedule';
}

/** Un pedido de subida sigue siendo válido durante una hora, mientras el plan actual no haya cambiado. */
function xp_upgrade_order_current(array $order): bool
{
    $sub = xp_one('SELECT * FROM subscriptions WHERE customer_id = ?', [$order['customer_id']]);
    $target = xp_plan_by_id($order['plan_id']);
    return $sub && $target && (int) $order['created_at'] > time() - 3600 && $target['devices'] === (int) $order['devices']
        && xp_upgrade_quote($sub, $target) !== null;
}

/**
 * Se llama dentro de la transacción que confirma un pago: deja la suscripción alineada con la licencia.
 * Cualquier pago confirmado cancela un cambio programado (el cliente acaba de elegir explícitamente).
 */
function xp_sub_after_payment(array $customer, array $order, string $licenseId, int $periodEnd): void
{
    $now = time();
    $sub = xp_one('SELECT * FROM subscriptions WHERE customer_id = ?' . xp_for_update(), [$customer['id']]);
    if (!$sub) {
        xp_exec('INSERT INTO subscriptions (id, customer_id, license_id, plan_id, status, period_end, auto_renew, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
            [xp_uuid(), $customer['id'], $licenseId, $order['plan_id'], 'active', $periodEnd, $now, $now]);
        return;
    }
    xp_exec("UPDATE subscriptions SET license_id = ?, plan_id = ?, status = 'active', period_end = ?, pending_plan_id = NULL, attempts = 0, next_attempt_at = NULL, updated_at = ? WHERE id = ?",
        [$licenseId, $order['plan_id'], $periodEnd, $now, $sub['id']]);
}

// ---------------------------------------------------------------- correos
function xp_sub_mail(array $customer, string $subject, string $title, string $html, string $label = 'Ver mi suscripción', string $path = '/portal/#planes'): void
{
    $base = xp_base_url();
    xp_send_mail($customer['email'], $subject, xp_mail_template($title,
        '<p>Hola ' . htmlspecialchars(explode(' ', trim($customer['name']))[0]) . ',</p>' . $html, $base !== '' ? $base . $path : null, $label));
}

function xp_card_label(?array $method): string
{
    return $method ? htmlspecialchars($method['brand']) . ' terminada en ' . htmlspecialchars($method['last_four']) : 'tu tarjeta guardada';
}

// ---------------------------------------------------------------- resumen para el portal
function xp_sub_public(array $customer): ?array
{
    $sub = xp_sub_for($customer);
    if (!$sub) { return null; }
    $plan = xp_plan_by_id($sub['plan_id']);
    if (!$plan) { return null; }
    $pending = $sub['pending_plan_id'] ? xp_plan_by_id($sub['pending_plan_id']) : null;
    $method = $sub['payment_method_id'] ? xp_one('SELECT id, brand, last_four FROM payment_methods WHERE id = ? AND customer_id = ?', [$sub['payment_method_id'], $customer['id']]) : null;
    $live = xp_sub_is_live($sub);
    $next = $pending ?: $plan;
    $quotes = [];
    if ($live) {
        foreach (xp_plans() as $candidate) {
            $q = xp_upgrade_quote($sub, $candidate);
            if ($q) { $quotes[$candidate['id']] = ['amountCents' => $q['amountCents'], 'waived' => $q['waived'], 'fullDiffCents' => $q['fullDiffCents']]; }
        }
    }
    $pub = fn(array $p) => ['id' => $p['id'], 'name' => $p['displayName'], 'cycle' => $p['cycle'], 'devices' => $p['devices'], 'priceCents' => $p['priceCents'], 'currency' => $p['currency']];
    return [
        'plan' => $pub($plan), 'status' => $sub['status'], 'live' => $live, 'periodEnd' => (int) $sub['period_end'],
        'autoRenew' => (bool) (int) $sub['auto_renew'],
        'card' => $method ? ['id' => $method['id'], 'brand' => $method['brand'], 'lastFour' => $method['last_four']] : null,
        'pendingPlan' => $pending ? $pub($pending) : null,
        'nextChargeAt' => (int) $sub['auto_renew'] ? (int) $sub['period_end'] : null,
        'nextChargeCents' => $next['priceCents'], 'quotes' => $quotes,
        'consentAt' => $sub['consent_at'] === null ? null : (int) $sub['consent_at'],
        'attempts' => (int) $sub['attempts'],
    ];
}

function xp_portal_subscription(array $customer): void
{
    xp_json(200, ['ok' => true, 'subscription' => xp_sub_public($customer)]);
}

// ---------------------------------------------------------------- renovación automática: activar / desactivar
/** Activa la renovación automática. $methodId debe ser una tarjeta guardada del cliente. Registra el consentimiento. */
function xp_sub_enable_auto(array $customer, string $methodId): bool
{
    $now = time();
    $ok = xp_tx(function () use ($customer, $methodId, $now) {
        $sub = xp_one('SELECT * FROM subscriptions WHERE customer_id = ?' . xp_for_update(), [$customer['id']]);
        $method = xp_one('SELECT id FROM payment_methods WHERE id = ? AND customer_id = ? AND environment = ?', [$methodId, $customer['id'], xp_culqi_environment()]);
        if (!$sub || !$method || $sub['status'] === 'canceled') { return false; }
        xp_exec('UPDATE subscriptions SET auto_renew = 1, payment_method_id = ?, consent_at = ?, consent_ip = ?, consent_version = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ?',
            [$methodId, $now, xp_clip(xp_ip(), 64), XP_CONSENT_VERSION, $now, $sub['id']]);
        return true;
    });
    if ($ok) {
        xp_log_event('auto_renew_on', null, null, $customer['id'], xp_ip());
        $sub = xp_one('SELECT * FROM subscriptions WHERE customer_id = ?', [$customer['id']]);
        $plan = xp_plan_by_id($sub['plan_id']);
        $method = xp_one('SELECT brand, last_four FROM payment_methods WHERE id = ?', [$methodId]);
        xp_sub_mail($customer, 'Activaste la renovación automática de Xport', 'Renovación automática activada',
            '<p>Autorizaste cobrar <b>' . xp_money_text($plan['priceCents'], $plan['currency']) . '</b> (plan ' . htmlspecialchars($plan['displayName']) . ') con ' . xp_card_label($method)
            . ' el <b>' . xp_date_es((int) $sub['period_end']) . '</b> y en cada renovación. Te avisaremos 3 días antes de cada cobro.</p><p>Puedes cancelar cuando quieras desde tu cuenta; tu plan sigue activo hasta el final del período pagado.</p>');
    }
    return $ok;
}

function xp_portal_sub_auto(array $customer): void
{
    $b = xp_body() ?? [];
    $sub = xp_sub_for($customer);
    if (!$sub || !xp_sub_is_live($sub)) {
        xp_json(409, ['ok' => false, 'error' => 'Primero necesitas un plan de pago vigente.']);
    }
    if (empty($b['enabled'])) {
        xp_exec('UPDATE subscriptions SET auto_renew = 0, pending_plan_id = NULL, next_attempt_at = NULL, updated_at = ? WHERE id = ?', [time(), $sub['id']]);
        xp_log_event('auto_renew_off', null, null, $customer['id'], xp_ip());
        xp_sub_mail($customer, 'Cancelaste la renovación automática de Xport', 'Renovación automática cancelada',
            '<p>No volveremos a cobrar tu tarjeta. Tu plan sigue activo hasta el <b>' . xp_date_es((int) $sub['period_end']) . '</b>; después pasará al plan gratuito.</p><p>Puedes volver a activarla cuando quieras.</p>');
        xp_json(200, ['ok' => true, 'subscription' => xp_sub_public($customer)]);
    }
    xp_require_culqi($customer);
    if (($b['consent'] ?? null) !== true) {
        xp_json(400, ['ok' => false, 'error' => 'Para activar la renovación automática necesitamos tu autorización expresa.']);
    }
    if ($sub['status'] === 'review') {
        xp_json(409, ['ok' => false, 'error' => 'Estamos verificando un cobro anterior. Inténtalo cuando se confirme.']);
    }
    if (!xp_sub_enable_auto($customer, xp_clip($b['cardId'] ?? '', 36))) {
        xp_json(404, ['ok' => false, 'error' => 'Elige una tarjeta guardada.']);
    }
    xp_json(200, ['ok' => true, 'subscription' => xp_sub_public($customer)]);
}

/** Programa (o quita) un cambio de plan para el final del período. */
function xp_portal_sub_schedule(array $customer): void
{
    $b = xp_body() ?? [];
    $sub = xp_sub_for($customer);
    if (!$sub || !xp_sub_is_live($sub)) {
        xp_json(409, ['ok' => false, 'error' => 'No tienes un plan de pago vigente.']);
    }
    if (!(int) $sub['auto_renew']) {
        xp_json(409, ['ok' => false, 'error' => 'Activa la renovación automática para programar un cambio, o elige el plan que quieras cuando venza el actual.']);
    }
    $planId = $b['planId'] ?? null;
    if ($planId === null || $planId === '' || $planId === $sub['plan_id']) {
        xp_exec('UPDATE subscriptions SET pending_plan_id = NULL, updated_at = ? WHERE id = ?', [time(), $sub['id']]);
        xp_json(200, ['ok' => true, 'subscription' => xp_sub_public($customer)]);
    }
    $plan = is_string($planId) ? xp_plan_by_id($planId) : null;
    if (!$plan || $plan['free']) { xp_json(400, ['ok' => false, 'error' => 'Plan no disponible.']); }
    if (xp_plan_change_kind($sub, $plan) === 'upgrade') {
        xp_json(409, ['ok' => false, 'error' => 'Subir de plan se aplica al instante. Elígelo desde Planes y precios.']);
    }
    xp_exec('UPDATE subscriptions SET pending_plan_id = ?, updated_at = ? WHERE id = ?', [$plan['id'], time(), $sub['id']]);
    xp_log_event('plan_change_scheduled', null, null, $customer['id'] . ' · ' . $plan['id']);
    xp_json(200, ['ok' => true, 'subscription' => xp_sub_public($customer)]);
}

// ---------------------------------------------------------------- cobro automático (se ejecuta por cron)
/**
 * Cobra las renovaciones vencidas, reintenta las fallidas y envía los avisos previos.
 * Seguro de ejecutar con frecuencia y en paralelo: cada suscripción se reserva de forma atómica antes de cobrar.
 *
 * @return array<string,int>
 */
function xp_run_renewals(?int $now = null): array
{
    $now ??= time();
    $stats = ['charged' => 0, 'failed' => 0, 'review' => 0, 'canceled' => 0, 'notices' => 0, 'skipped' => 0];
    if ((xp_config()['payment_mode'] ?? 'manual') !== 'culqi' || !xp_culqi_enabled()) {
        $stats['skipped'] = -1; // pagos en línea apagados: no se cobra nada
        return $stats;
    }
    $due = xp_all("SELECT id FROM subscriptions WHERE auto_renew = 1 AND status IN ('active', 'past_due') AND period_end <= ?
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY period_end ASC LIMIT 100", [$now, $now]);
    foreach ($due as $row) {
        try { xp_sub_renew_one($row['id'], $now, $stats); }
        catch (Throwable $e) { error_log('[xportbim-renewal] ' . get_class($e) . ': ' . $e->getMessage()); $stats['skipped']++; }
    }
    $soon = xp_all("SELECT * FROM subscriptions WHERE auto_renew = 1 AND status = 'active' AND period_end > ? AND period_end <= ?
        AND (notice_period_end IS NULL OR notice_period_end <> period_end) LIMIT 200", [$now, $now + XP_NOTICE_DAYS * XP_DAY]);
    foreach ($soon as $sub) {
        try {
            $customer = xp_one('SELECT * FROM customers WHERE id = ?', [$sub['customer_id']]);
            $plan = xp_plan_by_id($sub['pending_plan_id'] ?: $sub['plan_id']);
            $method = $sub['payment_method_id'] ? xp_one('SELECT brand, last_four FROM payment_methods WHERE id = ?', [$sub['payment_method_id']]) : null;
            if (!$customer || !$plan) { continue; }
            xp_exec('UPDATE subscriptions SET notice_period_end = ? WHERE id = ?', [$sub['period_end'], $sub['id']]);
            xp_sub_mail($customer, 'Tu suscripción de Xport se renueva pronto', 'Se acerca tu renovación',
                '<p>El <b>' . xp_date_es((int) $sub['period_end']) . '</b> cobraremos <b>' . xp_money_text($plan['priceCents'], $plan['currency']) . '</b> por el plan <b>' . htmlspecialchars($plan['displayName'])
                . '</b> (' . ($plan['cycle'] === 'annual' ? 'anual' : 'mensual') . ') a ' . xp_card_label($method) . '.</p><p>Si no quieres renovar, puedes cancelarlo antes desde tu cuenta; tu plan seguirá activo hasta esa fecha.</p>', 'Administrar mi suscripción');
            $stats['notices']++;
        } catch (Throwable $e) { error_log('[xportbim-renewal] aviso: ' . $e->getMessage()); }
    }
    return $stats;
}

function xp_sub_renew_one(string $subId, int $now, array &$stats): void
{
    $ctx = xp_tx(function () use ($subId, $now) {
        $sub = xp_one('SELECT * FROM subscriptions WHERE id = ?' . xp_for_update(), [$subId]);
        if (!$sub || !(int) $sub['auto_renew'] || !in_array($sub['status'], ['active', 'past_due'], true) || (int) $sub['period_end'] > $now
            || ($sub['next_attempt_at'] !== null && (int) $sub['next_attempt_at'] > $now)) { return null; }
        $customer = xp_one('SELECT * FROM customers WHERE id = ?', [$sub['customer_id']]);
        $lic = xp_one('SELECT * FROM licenses WHERE id = ?', [$sub['license_id']]);
        // Licencia suspendida o revocada por el administrador, o cuenta inexistente: nunca se cobra.
        if (!$customer || !$lic || $lic['status'] !== 'active') {
            xp_exec('UPDATE subscriptions SET auto_renew = 0, updated_at = ? WHERE id = ?', [$now, $sub['id']]);
            return ['skip' => true];
        }
        $plan = xp_plan_by_id($sub['pending_plan_id'] ?: $sub['plan_id']) ?: xp_plan_by_id($sub['plan_id']);
        if (!$plan || $plan['free']) {
            xp_exec('UPDATE subscriptions SET auto_renew = 0, updated_at = ? WHERE id = ?', [$now, $sub['id']]);
            return ['skip' => true];
        }
        $method = $sub['payment_method_id'] ? xp_one('SELECT * FROM payment_methods WHERE id = ? AND customer_id = ?', [$sub['payment_method_id'], $customer['id']]) : null;
        $ref = $method ? xp_card_ref($method) : null;
        $attempt = (int) $sub['attempts'] + 1;
        // Reserva: nadie más puede intentar esta renovación durante una hora.
        xp_exec('UPDATE subscriptions SET attempts = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?', [$attempt, $now + 3600, $now, $sub['id']]);
        $orderId = null;
        if ($ref) {
            $orderId = xp_uuid();
            $code = 'BF-' . substr(strtoupper(strtr(base64_encode(random_bytes(6)), '+/=', 'XYZ')), 0, 6);
            xp_exec("INSERT INTO orders (id, code, customer_id, license_id, plan_id, plan_name, seconds, devices, kind, amount_cents, currency, status, provider, tier, claimed_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'auto', ?, ?, 'processing', 'culqi', 0, ?, ?)",
                [$orderId, $code, $customer['id'], $lic['id'], $plan['id'], $plan['name'], $plan['seconds'], $plan['devices'], $plan['priceCents'], $plan['currency'], $now, $now]);
        }
        return ['sub' => $sub, 'customer' => $customer, 'license' => $lic, 'plan' => $plan, 'method' => $method, 'ref' => $ref, 'orderId' => $orderId, 'attempt' => $attempt];
    });
    if (!$ctx) { return; }
    if (!empty($ctx['skip'])) { $stats['skipped']++; return; }
    $sub = $ctx['sub']; $customer = $ctx['customer']; $plan = $ctx['plan'];

    if (!$ctx['ref']) {
        xp_sub_renewal_failed($ctx, 'La tarjeta guardada ya no está disponible.', $now, $stats);
        return;
    }
    $order = xp_one('SELECT * FROM orders WHERE id = ?', [$ctx['orderId']]);
    xp_log_event('renewal_attempt', $ctx['license']['id'], null, $order['code']);
    try {
        $r = xp_culqi_charge($order, $customer, $ctx['ref']);
    } catch (Throwable $e) {
        error_log('[xportbim-renewal] cobro: ' . $e->getMessage());
        $r = ['ok' => false, 'definitive' => false, 'chargeId' => '', 'message' => ''];
    }
    if ($r['ok']) {
        try {
            xp_mark_order_paid($order['id'], 'renovación automática', $r['chargeId']);
            xp_log_event('renewal_charged', $ctx['license']['id'], null, $order['code'] . ' · ' . $r['chargeId']);
        } catch (Throwable $e) {
            error_log('[xportbim-renewal] cobrado ' . $r['chargeId'] . ' pero no se pudo registrar: ' . $e->getMessage());
            xp_exec('UPDATE orders SET provider_ref = ? WHERE id = ?', [$r['chargeId'], $order['id']]);
            xp_exec("UPDATE subscriptions SET status = 'review', next_attempt_at = NULL, updated_at = ? WHERE id = ?", [$now, $sub['id']]);
            xp_log_event('payment_paid_not_recorded', null, null, $order['code'] . ' · ' . $r['chargeId']);
            xp_sub_alert_admin($customer, $order, 'Cobrado pero no registrado');
            $stats['review']++;
            return;
        }
        $fresh = xp_one('SELECT * FROM subscriptions WHERE id = ?', [$sub['id']]);
        xp_sub_mail($customer, 'Renovamos tu plan Xport', 'Renovación confirmada',
            '<p>Cobramos <b>' . xp_money_text((int) $order['amount_cents'], $order['currency']) . '</b> a ' . xp_card_label($ctx['method']) . ' por el plan <b>' . htmlspecialchars($plan['displayName'])
            . '</b>. Tu licencia ahora vence el <b>' . xp_date_es((int) $fresh['period_end']) . '</b>. Pedido ' . htmlspecialchars($order['code']) . '.</p>', 'Ver mi suscripción');
        $stats['charged']++;
        return;
    }
    if ($r['definitive']) {
        xp_exec("UPDATE orders SET status = 'cancelled' WHERE id = ?", [$order['id']]);
        xp_sub_renewal_failed($ctx, $r['message'], $now, $stats);
        return;
    }
    // Respuesta ambigua: puede haberse cobrado. No se reintenta; el administrador lo revisa en Pedidos.
    if ($r['chargeId'] !== '') { xp_exec('UPDATE orders SET provider_ref = ? WHERE id = ?', [$r['chargeId'], $order['id']]); }
    xp_exec("UPDATE subscriptions SET status = 'review', next_attempt_at = NULL, updated_at = ? WHERE id = ?", [$now, $sub['id']]);
    xp_log_event('payment_unknown', null, null, $order['code'] . ($r['chargeId'] !== '' ? ' · ' . $r['chargeId'] : ''));
    xp_sub_alert_admin($customer, $order, 'Respuesta ambigua de Culqi');
    $stats['review']++;
}

/** Cobro rechazado: gracia de 3 días con reintentos diarios; después se cancela la renovación. */
function xp_sub_renewal_failed(array $ctx, string $reason, int $now, array &$stats): void
{
    $sub = $ctx['sub']; $customer = $ctx['customer']; $lic = $ctx['license']; $plan = $ctx['plan'];
    $periodEnd = (int) $sub['period_end'];
    $final = $ctx['attempt'] >= XP_MAX_ATTEMPTS;
    xp_tx(function () use ($sub, $lic, $periodEnd, $final, $now) {
        if ($final) {
            xp_exec("UPDATE subscriptions SET status = 'canceled', auto_renew = 0, next_attempt_at = NULL, updated_at = ? WHERE id = ?", [$now, $sub['id']]);
        } else {
            xp_exec("UPDATE subscriptions SET status = 'past_due', next_attempt_at = ?, updated_at = ? WHERE id = ?", [$now + XP_RETRY_SECONDS, $now, $sub['id']]);
        }
        // El acceso continúa durante la gracia; si nunca se paga, la licencia vence sola al terminar.
        $graceEnd = $periodEnd + XP_GRACE_DAYS * XP_DAY;
        if ((int) $lic['expires_at'] < $graceEnd) { xp_exec('UPDATE licenses SET expires_at = ?, updated_at = ? WHERE id = ?', [$graceEnd, $now, $lic['id']]); }
    });
    xp_log_event('renewal_failed', $lic['id'], null, $ctx['attempt'] . '/' . XP_MAX_ATTEMPTS . ' · ' . mb_substr($reason, 0, 80));
    $graceEnd = xp_date_es($periodEnd + XP_GRACE_DAYS * XP_DAY);
    if ($final) {
        xp_sub_mail($customer, 'No pudimos renovar tu plan Xport', 'Cancelamos la renovación automática',
            '<p>No pudimos cobrar tu renovación tras varios intentos (' . htmlspecialchars($reason) . '). Cancelamos la renovación automática y tu plan termina el <b>' . $graceEnd . '</b>; después pasarás al plan gratuito.</p><p>Puedes volver a suscribirte cuando quieras con otra tarjeta.</p>', 'Elegir un plan');
        $stats['canceled']++;
    } else {
        xp_sub_mail($customer, 'No pudimos cobrar tu renovación de Xport', 'Problema con tu pago',
            '<p>No pudimos cobrar <b>' . xp_money_text($plan['priceCents'], $plan['currency']) . '</b> a ' . xp_card_label($ctx['method']) . ' (' . htmlspecialchars($reason) . ').</p><p>Reintentaremos mañana. Tu plan sigue activo hasta el <b>' . $graceEnd
            . '</b>. Para evitar interrupciones, actualiza tu tarjeta o paga desde tu cuenta.</p>', 'Actualizar mi tarjeta');
        $stats['failed']++;
    }
}

function xp_sub_alert_admin(array $customer, array $order, string $why): void
{
    $admin = (string) (xp_config()['admin_email'] ?? '');
    if ($admin === '') { return; }
    $base = xp_base_url();
    xp_send_mail($admin, 'Revisar cobro automático ' . $order['code'], xp_mail_template('Cobro automático por revisar',
        '<p><b>' . htmlspecialchars($why) . '</b>. Cliente: ' . htmlspecialchars($customer['email']) . ', pedido ' . htmlspecialchars($order['code']) . '. No se reintenta solo para no cobrar dos veces: revisa el cargo en el panel de Culqi y aprueba o cancela el pedido.</p>',
        $base !== '' ? $base . '/admin/' : null, 'Abrir el panel'));
}
