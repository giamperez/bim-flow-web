<?php
// Portal del cliente: /portal/api/*  (cuenta, compra/renovación y gestión de su propia licencia)
declare(strict_types=1);

const XP_USER_COOKIE = 'bf_user';
const XP_USER_TTL = 14 * 86400;
const XP_MAX_PENDING_ORDERS = 3;

// ---------------------------------------------------------------- claves guardadas (solo licencias del portal)
function xp_wrap_key(): string
{
    return hash_hkdf('sha256', xp_config()['session_secret'], 32, 'xportbim-keywrap');
}

function xp_encrypt_key(string $plain): string
{
    $iv = random_bytes(12);
    $ct = openssl_encrypt($plain, 'aes-256-gcm', xp_wrap_key(), OPENSSL_RAW_DATA, $iv, $tag);
    return xp_b64u_enc($iv . $tag . $ct);
}

function xp_decrypt_key(?string $blob): ?string
{
    if (!$blob) {
        return null;
    }
    $raw = xp_b64u_dec($blob);
    if (strlen($raw) < 29) {
        return null;
    }
    $pt = openssl_decrypt(substr($raw, 28), 'aes-256-gcm', xp_wrap_key(), OPENSSL_RAW_DATA, substr($raw, 0, 12), substr($raw, 12, 16));
    return $pt === false ? null : $pt;
}

// ---------------------------------------------------------------- planes y licencias
/** @return array<int,array<string,mixed>> */
function xp_plans(): array
{
    $c = xp_config();
    $raw = $c['plans'] ?? [
        ['id' => 'mensual', 'name' => 'Mensual', 'days' => 30, 'devices' => 1, 'price_cents' => 1500, 'currency' => 'USD', 'description' => 'Un equipo, renovación mes a mes.'],
        ['id' => 'anual', 'name' => 'Anual', 'days' => 365, 'devices' => 2, 'price_cents' => 15000, 'currency' => 'USD', 'description' => 'Dos equipos, el mejor precio.'],
        ['id' => 'prueba', 'name' => 'Prueba de 10 minutos', 'minutes' => 10, 'devices' => 1, 'price_cents' => 0, 'currency' => 'USD', 'description' => 'Solo para pruebas internas.', 'test' => true],
    ];
    $testMode = ($c['payment_mode'] ?? 'manual') === 'test';
    $plans = [];
    foreach ($raw as $p) {
        if (!empty($p['test']) && !$testMode) {
            continue;
        }
        $seconds = isset($p['minutes']) ? (int) $p['minutes'] * 60 : (int) ($p['days'] ?? 30) * XP_DAY;
        $plans[] = [
            'id' => (string) $p['id'],
            'name' => (string) $p['name'],
            'seconds' => $seconds,
            'devices' => (int) ($p['devices'] ?? 1),
            'priceCents' => (int) ($p['price_cents'] ?? 0),
            'currency' => (string) ($p['currency'] ?? 'USD'),
            'description' => (string) ($p['description'] ?? ''),
        ];
    }
    return $plans;
}

/**
 * Inserta una licencia nueva y devuelve [id, clave en claro]. Con store_key la clave queda cifrada para que su
 * dueño la vea en el portal; las creadas por el administrador solo muestran la clave una vez.
 *
 * @param array<string,mixed> $f
 * @return array{0:string,1:string}
 */
function xp_new_license(array $f): array
{
    $key = xp_generate_key();
    $id = xp_uuid();
    $t = time();
    xp_exec(
        "INSERT INTO licenses (id, key_hash, key_hint, customer_name, customer_email, plan, max_devices, status, expires_at, notes, created_at, updated_at, customer_id, key_enc)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)",
        [
            $id, xp_sha256($key), substr($key, -5), $f['customer_name'], $f['customer_email'] ?? '', $f['plan'] ?? 'standard',
            (int) $f['max_devices'], (int) $f['expires_at'], $f['notes'] ?? '', $t, $t,
            $f['customer_id'] ?? null, !empty($f['store_key']) ? xp_encrypt_key($key) : null,
        ]
    );
    return [$id, $key];
}

/** Idempotente: confirma un pedido pendiente y crea o renueva la licencia de su cliente. */
function xp_mark_order_paid(string $orderId, string $actor = 'system'): ?array
{
    return xp_tx(function () use ($orderId, $actor) {
        $o = xp_one('SELECT * FROM orders WHERE id = ?' . xp_for_update(), [$orderId]);
        if (!$o || $o['status'] !== 'pending') {
            return null;
        }
        $cust = xp_one('SELECT * FROM customers WHERE id = ?', [$o['customer_id']]);
        $lic = xp_one('SELECT * FROM licenses WHERE customer_id = ? ORDER BY created_at DESC LIMIT 1', [$o['customer_id']]);
        $t = time();
        if (!$lic) {
            [$licenseId] = xp_new_license([
                'customer_name' => $cust['name'], 'customer_email' => $cust['email'], 'plan' => $o['plan_name'],
                'max_devices' => (int) $o['devices'], 'expires_at' => $t + (int) $o['seconds'],
                'customer_id' => $cust['id'], 'store_key' => true,
            ]);
        } else {
            $licenseId = $lic['id'];
            $expires = max((int) $lic['expires_at'], $t) + (int) $o['seconds'];
            xp_exec(
                'UPDATE licenses SET expires_at = ?, max_devices = ?, plan = ?, updated_at = ? WHERE id = ?',
                [$expires, max((int) $lic['max_devices'], (int) $o['devices']), $o['plan_name'], $t, $licenseId]
            );
        }
        xp_exec("UPDATE orders SET status = 'paid', paid_at = ?, license_id = ? WHERE id = ?", [$t, $licenseId, $orderId]);
        xp_log_event('order_paid', $licenseId, null, $o['code'] . ' · ' . $o['plan_name'] . ' · ' . $actor);
        return ['licenseId' => $licenseId, 'code' => $o['code']];
    });
}

// ---------------------------------------------------------------- sesión del cliente
function xp_user_cookie_create(string $customerId): string
{
    $body = xp_b64u_enc(json_encode(['cid' => $customerId, 'exp' => time() + XP_USER_TTL]));
    return $body . '.' . xp_b64u_enc(hash_hmac('sha256', $body, xp_user_cookie_key(), true));
}

// Clave distinta de la del administrador: una cookie de cliente jamás vale como sesión de admin.
function xp_user_cookie_key(): string
{
    return hash_hmac('sha256', 'portal-session', xp_config()['session_secret'], true);
}

function xp_current_customer(): ?array
{
    $cookie = $_COOKIE[XP_USER_COOKIE] ?? '';
    if (!is_string($cookie) || substr_count($cookie, '.') !== 1) {
        return null;
    }
    [$body, $sig] = explode('.', $cookie);
    if (!hash_equals(hash_hmac('sha256', $body, xp_user_cookie_key(), true), xp_b64u_dec($sig))) {
        return null;
    }
    $data = json_decode(xp_b64u_dec($body), true);
    if (!is_array($data) || ($data['exp'] ?? 0) <= time() || !is_string($data['cid'] ?? null)) {
        return null;
    }
    return xp_one('SELECT * FROM customers WHERE id = ?', [$data['cid']]);
}

function xp_set_user_cookie(string $customerId): void
{
    setcookie(XP_USER_COOKIE, xp_user_cookie_create($customerId), [
        'expires' => time() + XP_USER_TTL, 'path' => '/', 'secure' => xp_is_https(), 'httponly' => true, 'samesite' => 'Strict',
    ]);
}

function xp_customer_public(array $c): array
{
    return ['id' => $c['id'], 'email' => $c['email'], 'name' => $c['name']];
}

function xp_count_events(string $type, string $where, array $params, int $seconds): int
{
    $row = xp_one("SELECT COUNT(*) AS n FROM events WHERE type = ? AND $where AND created_at > ?", array_merge([$type], $params, [time() - $seconds]));
    return (int) $row['n'];
}

// ---------------------------------------------------------------- rutas
function xp_route_portal(string $method, string $route): void
{
    if ($route === 'plans' && $method === 'GET') {
        xp_json(200, ['ok' => true, 'plans' => xp_plans(), 'paymentMode' => xp_config()['payment_mode'] ?? 'manual']);
    }
    if ($route === 'lead' && $method === 'POST') {
        xp_portal_lead();
    }
    if ($route === 'register' && $method === 'POST') {
        xp_portal_register();
    }
    if ($route === 'login' && $method === 'POST') {
        xp_portal_login();
    }
    if ($route === 'logout' && $method === 'POST') {
        setcookie(XP_USER_COOKIE, '', ['expires' => 1, 'path' => '/', 'httponly' => true, 'samesite' => 'Strict']);
        xp_json(200, ['ok' => true]);
    }

    $customer = xp_current_customer();
    if (!$customer) {
        xp_json(401, ['ok' => false, 'error' => 'unauthorized']);
    }
    if ($method !== 'GET' && ($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'bimflow') {
        xp_json(403, ['ok' => false, 'error' => 'csrf']);
    }

    $parts = explode('/', $route);
    if ($route === 'me' && $method === 'GET') {
        xp_json(200, ['ok' => true, 'customer' => xp_customer_public($customer)]);
    }
    if ($route === 'license' && $method === 'GET') {
        xp_portal_license($customer);
    }
    if ($route === 'orders' && $method === 'GET') {
        xp_portal_orders($customer);
    }
    if ($route === 'orders' && $method === 'POST') {
        xp_portal_create_order($customer);
    }
    if ($route === 'license/regenerate-key' && $method === 'POST') {
        xp_portal_regenerate($customer);
    }
    if (count($parts) === 4 && $parts[0] === 'license' && $parts[1] === 'devices' && $parts[3] === 'release' && $method === 'POST') {
        xp_portal_release_device($customer, $parts[2]);
    }
    xp_json(404, ['ok' => false, 'error' => 'not_found']);
}

function xp_portal_register(): void
{
    $ip = xp_ip();
    if ($ip !== '' && xp_count_events('portal_register', 'ip = ?', [$ip], 3600) >= 10) {
        xp_json(429, ['ok' => false, 'error' => 'Demasiados registros desde su red. Inténtelo más tarde.']);
    }
    $b = xp_body() ?? [];
    $email = strtolower(xp_clip($b['email'] ?? '', 160));
    $name = xp_clip($b['name'] ?? '', 120);
    $password = is_string($b['password'] ?? null) ? $b['password'] : '';
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        xp_json(400, ['ok' => false, 'error' => 'Ingrese un correo válido.']);
    }
    if ($name === '') {
        xp_json(400, ['ok' => false, 'error' => 'Ingrese su nombre o el de su empresa.']);
    }
    if (strlen($password) < 8 || strlen($password) > 200) {
        xp_json(400, ['ok' => false, 'error' => 'La contraseña debe tener al menos 8 caracteres.']);
    }
    if (xp_one('SELECT id FROM customers WHERE email = ?', [$email])) {
        xp_json(409, ['ok' => false, 'error' => 'Ya existe una cuenta con ese correo. Inicie sesión.']);
    }
    $id = xp_uuid();
    xp_exec('INSERT INTO customers (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', [$id, $email, $name, password_hash($password, PASSWORD_DEFAULT), time()]);
    xp_log_event('portal_register', null, null, $email, $ip);
    xp_set_user_cookie($id);
    xp_json(201, ['ok' => true, 'customer' => ['id' => $id, 'email' => $email, 'name' => $name]]);
}

function xp_portal_login(): void
{
    $ip = xp_ip();
    $b = xp_body() ?? [];
    $email = strtolower(xp_clip($b['email'] ?? '', 160));
    $password = is_string($b['password'] ?? null) ? $b['password'] : '';
    $emailKey = substr(xp_sha256($email), 0, 16);
    $byIp = $ip === '' ? 0 : xp_count_events('portal_login_failed', 'ip = ?', [$ip], 900);
    $byEmail = xp_count_events('portal_login_failed', 'detail = ?', [$emailKey], 900);
    if ($byIp >= 8 || $byEmail >= 10) {
        xp_json(429, ['ok' => false, 'error' => 'Demasiados intentos. Espere 15 minutos.']);
    }
    $c = $email !== '' ? xp_one('SELECT * FROM customers WHERE email = ?', [$email]) : null;
    // Se verifica siempre una contraseña para que el tiempo de respuesta no delate si el correo existe.
    $hash = $c['password_hash'] ?? password_hash('no-existe', PASSWORD_DEFAULT);
    if (!password_verify($password, $hash) || !$c) {
        xp_log_event('portal_login_failed', null, null, $emailKey, $ip);
        xp_json(401, ['ok' => false, 'error' => 'Correo o contraseña incorrectos.']);
    }
    xp_set_user_cookie($c['id']);
    xp_json(200, ['ok' => true, 'customer' => xp_customer_public($c)]);
}

function xp_portal_license_row(array $customer): ?array
{
    return xp_one('SELECT * FROM licenses WHERE customer_id = ? ORDER BY created_at DESC LIMIT 1', [$customer['id']]);
}

function xp_portal_license(array $customer): void
{
    $lic = xp_portal_license_row($customer);
    if (!$lic) {
        xp_json(200, ['ok' => true, 'license' => null]);
    }
    $devices = xp_all('SELECT * FROM devices WHERE license_id = ? ORDER BY status ASC, last_seen DESC', [$lic['id']]);
    $public = xp_license_public($lic, 7); // el cliente ve "por vencer" solo en la última semana
    $public['key'] = xp_decrypt_key($lic['key_enc'] ?? null);
    $public['devices'] = array_map(function ($d) {
        return [
            'id' => $d['id'], 'name' => $d['device_name'], 'revitVersion' => $d['revit_version'], 'appVersion' => $d['app_version'],
            'status' => $d['status'], 'lastSeen' => (int) $d['last_seen'],
        ];
    }, $devices);
    $public['secondsLeft'] = max(0, (int) $lic['expires_at'] - time());
    xp_json(200, ['ok' => true, 'license' => $public]);
}

function xp_order_public(array $o): array
{
    return [
        'code' => $o['code'], 'planName' => $o['plan_name'], 'amountCents' => (int) $o['amount_cents'], 'currency' => $o['currency'],
        'status' => $o['status'], 'kind' => $o['kind'], 'createdAt' => (int) $o['created_at'],
        'paidAt' => $o['paid_at'] === null ? null : (int) $o['paid_at'],
    ];
}

function xp_portal_orders(array $customer): void
{
    $rows = xp_all('SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50', [$customer['id']]);
    xp_json(200, ['ok' => true, 'orders' => array_map('xp_order_public', $rows)]);
}

function xp_portal_create_order(array $customer): void
{
    $b = xp_body() ?? [];
    $plan = null;
    foreach (xp_plans() as $p) {
        if ($p['id'] === ($b['planId'] ?? null)) {
            $plan = $p;
        }
    }
    if (!$plan) {
        xp_json(400, ['ok' => false, 'error' => 'Plan no disponible.']);
    }
    $pending = (int) xp_one("SELECT COUNT(*) AS n FROM orders WHERE customer_id = ? AND status = 'pending'", [$customer['id']])['n'];
    if ($pending >= XP_MAX_PENDING_ORDERS) {
        xp_json(409, ['ok' => false, 'error' => 'Ya tiene pedidos pendientes de pago. Espere su confirmación o cancélelos con soporte.']);
    }
    $kind = xp_portal_license_row($customer) ? 'renew' : 'new';
    $id = xp_uuid();
    $code = 'BF-' . substr(strtoupper(strtr(base64_encode(random_bytes(6)), '+/=', 'XYZ')), 0, 6);
    $mode = xp_config()['payment_mode'] ?? 'manual';
    xp_exec(
        "INSERT INTO orders (id, code, customer_id, plan_id, plan_name, seconds, devices, kind, amount_cents, currency, status, provider, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
        [$id, $code, $customer['id'], $plan['id'], $plan['name'], $plan['seconds'], $plan['devices'], $kind, $plan['priceCents'], $plan['currency'], $mode, time()]
    );
    xp_log_event('order_created', null, null, $code . ' · ' . $plan['name'] . ' · ' . $customer['email']);
    $paid = false;
    if ($mode === 'test') {
        $paid = xp_mark_order_paid($id, 'modo de prueba') !== null;
    }
    $order = xp_one('SELECT * FROM orders WHERE id = ?', [$id]);
    xp_json(201, [
        'ok' => true,
        'paid' => $paid,
        'order' => xp_order_public($order),
        'instructions' => $paid ? '' : (string) (xp_config()['payment_instructions']
            ?? 'Realice el pago e indique el código del pedido como referencia. Envíe el comprobante a soporte; activaremos su licencia en cuanto se confirme.'),
    ]);
}

function xp_portal_release_device(array $customer, string $deviceId): void
{
    $lic = xp_portal_license_row($customer);
    $dev = $lic ? xp_one("SELECT device_name FROM devices WHERE id = ? AND license_id = ? AND status = 'active'", [$deviceId, $lic['id']]) : null;
    if (!$dev) {
        xp_json(404, ['ok' => false, 'error' => 'Equipo no encontrado o ya liberado.']);
    }
    xp_exec("UPDATE devices SET status = 'released', released_at = ? WHERE id = ?", [time(), $deviceId]);
    xp_log_event('released_by_owner', $lic['id'], $deviceId, $dev['device_name'], xp_ip());
    xp_json(200, ['ok' => true]);
}

function xp_portal_regenerate(array $customer): void
{
    $lic = xp_portal_license_row($customer);
    if (!$lic) {
        xp_json(404, ['ok' => false, 'error' => 'Aún no tiene una licencia.']);
    }
    $key = xp_generate_key();
    xp_exec(
        'UPDATE licenses SET key_hash = ?, key_hint = ?, key_enc = ?, updated_at = ? WHERE id = ?',
        [xp_sha256($key), substr($key, -5), xp_encrypt_key($key), time(), $lic['id']]
    );
    xp_log_event('owner_key_regenerated', $lic['id'], null, '', xp_ip());
    xp_json(200, ['ok' => true, 'key' => $key]);
}

/** Solicitud de demo desde la landing: se guarda como evento para verla en el panel de administración. */
function xp_portal_lead(): void
{
    $ip = xp_ip();
    if ($ip !== '' && xp_count_events('demo_request', 'ip = ?', [$ip], 3600) >= 5) {
        xp_json(429, ['ok' => false, 'error' => 'Demasiadas solicitudes. Inténtelo más tarde.']);
    }
    $b = xp_body() ?? [];
    $email = strtolower(xp_clip($b['email'] ?? '', 160));
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        xp_json(400, ['ok' => false, 'error' => 'Ingrese un correo válido.']);
    }
    xp_log_event('demo_request', null, null, $email, $ip);
    xp_json(200, ['ok' => true]);
}
