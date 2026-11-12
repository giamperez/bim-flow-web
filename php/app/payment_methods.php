<?php
declare(strict_types=1);

const XP_MAX_CARDS = 5;

function xp_culqi_request(string $method, string $resource, ?array $body = null): array
{
    return xp_http_json($method, xp_culqi_api_base() . $resource,
        ['Authorization: Bearer ' . xp_culqi_cfg()['secret_key'], 'Content-Type: application/json'], $body);
}

/** Diagnostic only: status and Culqi's own error codes, never customer data or keys. */
function xp_culqi_log_failure(string $where, int $status, array $r): void
{
    error_log('[xportbim-culqi] ' . $where . ' status=' . $status . ' ' . json_encode(array_intersect_key($r, array_flip(['object', 'type', 'code', 'decline_code', 'merchant_message', 'user_message']))));
}

function xp_require_culqi(array $customer): void
{
    if ((xp_config()['payment_mode'] ?? 'manual') !== 'culqi' || !xp_culqi_enabled()) {
        xp_json(503, ['ok' => false, 'error' => 'El pago con tarjeta no está disponible en este momento.']);
    }
    if (xp_verification_required() && empty($customer['email_verified_at'])) {
        xp_json(403, ['ok' => false, 'error' => 'Confirma tu correo antes de añadir una tarjeta.']);
    }
}

/** Referencia de Culqi de una tarjeta guardada (descifrada solo en memoria, para el cobro o el borrado). */
function xp_card_ref(array $row): ?string
{
    return xp_vault_open($row['provider_id'], xp_vault_aad('pm', $row['customer_id'], $row['environment']));
}

/** Datos que Culqi exige para crear un cliente (y por tanto para guardar una tarjeta). Lista legible de lo que falta. */
function xp_billing_missing(array $customer): array
{
    $billing = json_decode($customer['billing_json'] ?? '{}', true) ?: [];
    $missing = [];
    if (count(preg_split('/\s+/', trim($customer['name']), 2)) < 2) { $missing[] = 'apellido'; }
    if (empty($customer['phone'])) { $missing[] = 'teléfono'; }
    if (empty($billing['address'])) { $missing[] = 'dirección'; }
    if (empty($billing['city'])) { $missing[] = 'ciudad'; }
    return $missing;
}

function xp_portal_cards(array $customer): void
{
    $rows = xp_all('SELECT id, brand, last_four, created_at FROM payment_methods WHERE customer_id = ? AND environment = ? ORDER BY created_at DESC', [$customer['id'], xp_culqi_environment()]);
    $auto = xp_one('SELECT payment_method_id FROM subscriptions WHERE customer_id = ? AND auto_renew = 1', [$customer['id']]);
    xp_json(200, ['ok' => true, 'cards' => array_map(fn($r) => ['id' => $r['id'], 'brand' => $r['brand'], 'lastFour' => $r['last_four'],
        'createdAt' => (int) $r['created_at'], 'autoRenew' => $auto && $auto['payment_method_id'] === $r['id']], $rows)]);
}

/**
 * Guarda una tarjeta a partir de un token de Culqi (un solo uso). Devuelve ['ok'=>true,'id'=>id local] o
 * ['ok'=>false,'status'=>http,'error'=>texto]. No cobra nada.
 */
function xp_card_store(array $customer, string $token): array
{
    $env = xp_culqi_environment();
    if (xp_count_events('card_save_attempt', 'detail = ?', [$customer['id']], 3600) >= 8) {
        return ['ok' => false, 'status' => 429, 'error' => 'Demasiados intentos. Inténtalo en una hora.'];
    }
    $count = (int) xp_one('SELECT COUNT(*) AS n FROM payment_methods WHERE customer_id = ? AND environment = ?', [$customer['id'], $env])['n'];
    if ($count >= XP_MAX_CARDS) { return ['ok' => false, 'status' => 409, 'error' => 'Puedes guardar hasta cinco tarjetas. Elimina una antes de añadir otra.']; }
    $missing = xp_billing_missing($customer);
    if ($missing) {
        return ['ok' => false, 'status' => 400, 'code' => 'billing_required', 'missing' => $missing,
            'error' => 'Completa ' . implode(', ', $missing) . ' en tu perfil y facturación antes de guardar una tarjeta.'];
    }
    $billing = json_decode($customer['billing_json'] ?? '{}', true) ?: [];
    $names = preg_split('/\s+/', trim($customer['name']), 2);
    xp_log_event('card_save_attempt', null, null, $customer['id'], xp_ip());
    // Serializa la creación del cliente de Culqi para no duplicarlo entre dos pestañas.
    $provider = xp_tx(function () use ($customer, $env, $billing, $names) {
        xp_one('SELECT id FROM customers WHERE id = ?' . xp_for_update(), [$customer['id']]);
        $row = xp_one('SELECT provider_id FROM payment_customers WHERE customer_id = ? AND environment = ?', [$customer['id'], $env]);
        if ($row) { return xp_vault_open($row['provider_id'], xp_vault_aad('pc', $customer['id'], $env)); }
        [$status, $r] = xp_culqi_request('POST', '/customers', ['first_name' => $names[0], 'last_name' => $names[1],
            'email' => $customer['email'], 'phone_number' => preg_replace('/\D/', '', $customer['phone']), 'address' => $billing['address'],
            'address_city' => $billing['city'], 'country_code' => $billing['country'] ?: 'PE']);
        if (!in_array($status, [200, 201], true) || ($r['object'] ?? '') !== 'customer' || empty($r['id'])) { xp_culqi_log_failure('customers', (int) $status, is_array($r) ? $r : []); return null; }
        xp_exec('INSERT INTO payment_customers (customer_id, environment, provider_id) VALUES (?, ?, ?)',
            [$customer['id'], $env, xp_vault_seal($r['id'], xp_vault_aad('pc', $customer['id'], $env))]);
        return $r['id'];
    });
    if (!$provider) { return ['ok' => false, 'status' => 502, 'error' => 'Culqi no pudo registrar tus datos. No se realizó ningún cobro.']; }
    [$status, $r] = xp_culqi_request('POST', '/cards', ['customer_id' => $provider, 'token_id' => $token]);
    $source = $r['source'] ?? $r['token'] ?? [];
    $last = (string) ($source['last_four'] ?? '');
    if (!in_array($status, [200, 201], true) || ($r['object'] ?? '') !== 'card' || empty($r['id']) || !preg_match('/^\d{4}$/', $last)) {
        xp_culqi_log_failure('cards', (int) $status, is_array($r) ? $r : []);
        return ['ok' => false, 'status' => 502, 'error' => 'No pudimos confirmar el guardado de la tarjeta con Culqi. No se realizó ningún cobro.'];
    }
    $id = xp_uuid();
    xp_exec('INSERT INTO payment_methods (id, customer_id, environment, provider_id, brand, last_four, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [$id, $customer['id'], $env, xp_vault_seal($r['id'], xp_vault_aad('pm', $customer['id'], $env)), xp_clip($source['iin']['card_brand'] ?? 'Tarjeta', 24), $last, time()]);
    xp_log_event('card_saved', null, null, $customer['id'], xp_ip());
    return ['ok' => true, 'id' => $id];
}

function xp_portal_save_card(array $customer): void
{
    xp_require_culqi($customer);
    $b = xp_body() ?? [];
    $token = $b['token'] ?? '';
    $env = xp_culqi_environment();
    if (($b['consent'] ?? null) !== true || !is_string($token) || !preg_match('/^tkn_' . $env . '_[A-Za-z0-9]{4,80}$/', $token)) {
        xp_json(400, ['ok' => false, 'error' => 'Se necesita tu autorización y una tarjeta válida de Culqi.']);
    }
    $r = xp_card_store($customer, $token);
    if (!$r['ok']) {
        xp_json($r['status'], array_filter(['ok' => false, 'error' => $r['error'], 'code' => $r['code'] ?? null, 'missing' => $r['missing'] ?? null]));
    }
    xp_json(201, ['ok' => true]);
}

function xp_portal_delete_card(array $customer, string $id): void
{
    xp_require_culqi($customer);
    $row = xp_one('SELECT * FROM payment_methods WHERE id = ? AND customer_id = ? AND environment = ?', [$id, $customer['id'], xp_culqi_environment()]);
    if (!$row) { xp_json(404, ['ok' => false, 'error' => 'Tarjeta no encontrada.']); }
    $inUse = xp_one('SELECT id FROM subscriptions WHERE customer_id = ? AND auto_renew = 1 AND payment_method_id = ?', [$customer['id'], $id]);
    if ($inUse) {
        xp_json(409, ['ok' => false, 'error' => 'Esta tarjeta paga tu renovación automática. Cambia de tarjeta o desactiva la renovación antes de eliminarla.']);
    }
    $ref = xp_card_ref($row);
    if ($ref === null) { xp_json(500, ['ok' => false, 'error' => 'No se pudo leer la tarjeta guardada.']); }
    [$status, $res] = xp_culqi_request('DELETE', '/cards/' . rawurlencode($ref));
    if (!(($status >= 200 && $status < 300) || ($status === 404 && ($res['object'] ?? '') === 'error'))) {
        xp_json(502, ['ok' => false, 'error' => 'Culqi no confirmó la eliminación. Inténtalo de nuevo.']);
    }
    xp_exec('DELETE FROM payment_methods WHERE id = ? AND customer_id = ?', [$id, $customer['id']]);
    xp_log_event('card_deleted', null, null, $customer['id'], xp_ip());
    xp_json(200, ['ok' => true]);
}
