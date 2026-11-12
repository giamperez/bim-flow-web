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
// Dominios de correo desechable: no se aceptan para crear cuentas (evita fabricar pruebas gratuitas sin fin).
const XP_DISPOSABLE_DOMAINS = [
    'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'sharklasers.com', '10minutemail.com',
    '10minutemail.net', 'tempmail.com', 'temp-mail.org', 'temp-mail.io', 'tempail.com', 'yopmail.com', 'yopmail.net',
    'trashmail.com', 'trashmail.net', 'getnada.com', 'nada.email', 'maildrop.cc', 'dispostable.com', 'fakeinbox.com',
    'throwawaymail.com', 'mohmal.com', 'emailondeck.com', 'mintemail.com', 'spamgourmet.com', 'burnermail.io', 'moakt.com',
    'tmpmail.org', 'tmpmail.net', 'mailnesia.com', 'mytemp.email', 'inboxkitten.com', 'discard.email', 'mailcatch.com',
    'grr.la', 'guerrillamailblock.com', 'spam4.me', 'tempinbox.com', 'emailfake.com', 'fakemail.net', 'mail.tm', 'tmail.ws',
    'getairmail.com', 'anonbox.net', 'mailforspam.com', 'harakirimail.com', 'tempr.email', 'dropmail.me', '33mail.com',
];

/** Forma canónica de un correo: minúsculas, sin "+etiqueta" y, en Gmail, sin puntos. Detecta alias de la misma bandeja. */
function xp_normalize_email(string $email): string
{
    $email = strtolower(trim($email));
    $at = strrpos($email, '@');
    if ($at === false) {
        return $email;
    }
    $local = substr($email, 0, $at);
    $domain = substr($email, $at + 1);
    $plus = strpos($local, '+');
    if ($plus !== false) {
        $local = substr($local, 0, $plus);
    }
    if ($domain === 'googlemail.com' || $domain === 'gmail.com') {
        $domain = 'gmail.com';
        $local = str_replace('.', '', $local);
    }
    return $local . '@' . $domain;
}

function xp_is_disposable_email(string $email): bool
{
    $domain = substr(strrchr($email, '@') ?: '@', 1);
    $blocked = array_merge(XP_DISPOSABLE_DOMAINS, (array) (xp_config()['blocked_email_domains'] ?? []));
    return in_array(strtolower($domain), $blocked, true);
}

// ---------------------------------------------------------------- catálogo vigente
/** @return array<int,array<string,mixed>> */
function xp_plans(?array $customer = null): array
{
    // Catálogo vigente. Los pedidos históricos conservan su importe y duración originales.
    // No reutilizar los antiguos tramos de precio ni overrides de config.php.
    $plans = [['id' => 'gratis', 'name' => 'Gratuito', 'displayName' => 'Gratuito', 'trial' => false, 'free' => true,
        'cycle' => 'free', 'seconds' => 0, 'devices' => 1, 'priceCents' => 0, 'currency' => 'PEN', 'monthlyLimit' => 150,
        'description' => 'PDF y DWG con los ajustes esenciales. 150 archivos al mes.']];
    foreach ([['mensual','Individual',1,1990,15900],['equipo','Equipo',3,4990,39900],['estudio','Estudio',7,9990,79900]] as [$id,$name,$devices,$monthly,$annual]) {
        foreach (['monthly','annual'] as $cycle) {
            $plans[] = ['id' => $cycle === 'monthly' ? $id : ($id === 'mensual' ? 'anual' : $id . '_anual'),
                'name' => $name . ($cycle === 'annual' ? ' anual' : ''), 'displayName' => $name,
                'trial' => false, 'free' => false, 'cycle' => $cycle, 'seconds' => ($cycle === 'monthly' ? 30 : 365) * XP_DAY,
                'devices' => $devices, 'priceCents' => $cycle === 'monthly' ? $monthly : $annual,
                'currency' => 'PEN', 'monthlyLimit' => 0, 'description' => 'Todas las opciones y formatos. Sin límite de archivos.'];
        }
    }
    return $plans;
}

/** La prueba gratuita es única por cliente: solo si nunca tuvo licencia ni pidió otra prueba. */
function xp_trial_available(array $customer): bool
{
    if (!empty($customer['trial_started_at'])) { return false; }
    $lic = xp_portal_license_row($customer);
    if (!$lic && !empty($customer['free_started_at'])) { return false; }
    if ($lic && (($lic['access_mode'] ?? 'paid') !== 'free' || $lic['status'] !== 'active')) { return false; }
    return !xp_one("SELECT id FROM orders WHERE customer_id = ? AND status = 'paid' AND amount_cents > 0 LIMIT 1", [$customer['id']]);
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
        "INSERT INTO licenses (id, key_hash, key_hint, customer_name, customer_email, plan, max_devices, status, expires_at, notes, created_at, updated_at, customer_id, key_enc, is_trial, access_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            $id, xp_sha256($key), substr($key, -5), $f['customer_name'], $f['customer_email'] ?? '', $f['plan'] ?? 'standard',
            (int) $f['max_devices'], (int) $f['expires_at'], $f['notes'] ?? '', $t, $t,
            $f['customer_id'] ?? null, !empty($f['store_key']) ? xp_encrypt_key($key) : null, !empty($f['is_trial']) ? 1 : 0, $f['access_mode'] ?? 'paid',
        ]
    );
    return [$id, $key];
}

/** Idempotente: confirma un pedido pendiente y crea o renueva la licencia de su cliente. */
function xp_mark_order_paid(string $orderId, string $actor = 'system', string $providerRef = ''): ?array
{
    $result = xp_tx(function () use ($orderId, $actor, $providerRef) {
        $o = xp_one('SELECT * FROM orders WHERE id = ?' . xp_for_update(), [$orderId]);
        if (!$o || !in_array($o['status'], ['pending', 'processing'], true)) {
            return null;
        }
        $cust = xp_one('SELECT * FROM customers WHERE id = ?' . xp_for_update(), [$o['customer_id']]);
        $lic = xp_one('SELECT * FROM licenses WHERE customer_id = ? ORDER BY created_at DESC LIMIT 1' . xp_for_update(), [$o['customer_id']]);
        $t = time();
        xp_exec('UPDATE customers SET free_started_at = COALESCE(free_started_at, ?) WHERE id = ?', [$t, $cust['id']]);
        if (!$lic) {
            [$licenseId] = xp_new_license([
                'customer_name' => $cust['name'], 'customer_email' => $cust['email'], 'plan' => $o['plan_name'],
                'max_devices' => (int) $o['devices'], 'expires_at' => $t + (int) $o['seconds'],
                'customer_id' => $cust['id'], 'store_key' => true, 'is_trial' => $o['kind'] === 'trial',
            ]);
        } else {
            $licenseId = $lic['id'];
            // Un cambio de capacidad empieza un período nuevo; renovar el mismo plan conserva los días restantes.
            $samePlan = ($lic['access_mode'] ?? 'paid') === 'paid' && $lic['plan'] === $o['plan_name'];
            $expires = ($samePlan ? max((int) $lic['expires_at'], $t) : $t) + (int) $o['seconds'];
            xp_exec(
                "UPDATE licenses SET expires_at = ?, max_devices = ?, plan = ?, is_trial = 0, access_mode = 'paid', updated_at = ? WHERE id = ?",
                [$expires, (int) $o['devices'], $o['plan_name'], $t, $licenseId]
            );
            $active = xp_all("SELECT id FROM devices WHERE license_id = ? AND status = 'active' ORDER BY last_seen DESC, id", [$licenseId]);
            foreach (array_slice($active, (int) $o['devices']) as $extra) {
                xp_exec("UPDATE devices SET status = 'released', released_at = ? WHERE id = ?", [$t, $extra['id']]);
                xp_log_event('released_plan_change', $licenseId, $extra['id'], $o['code']);
            }
        }
        xp_exec("UPDATE orders SET status = 'paid', paid_at = ?, license_id = ?, provider_ref = COALESCE(NULLIF(?, ''), provider_ref) WHERE id = ?", [$t, $licenseId, $providerRef, $orderId]);
        xp_log_event('order_paid', $licenseId, null, $o['code'] . ' · ' . $o['plan_name'] . ' · ' . $actor);
        return ['licenseId' => $licenseId, 'code' => $o['code']];
    });
    if ($result) {
        xp_notify_license_ready($orderId);
    }
    return $result;
}

// ---------------------------------------------------------------- sesión del cliente
function xp_user_cookie_create(string $customerId, int $sessionVersion = 0): string
{
    $body = xp_b64u_enc(json_encode(['cid' => $customerId, 'sv' => $sessionVersion, 'exp' => time() + XP_USER_TTL]));
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
    $c = xp_one('SELECT * FROM customers WHERE id = ?', [$data['cid']]);
    // Al cambiar la contraseña sube la versión de sesión y las cookies anteriores dejan de valer.
    return $c && (int) ($data['sv'] ?? 0) === (int) ($c['session_version'] ?? 0) ? $c : null;
}

function xp_set_user_cookie(string $customerId, int $sessionVersion = 0): void
{
    setcookie(XP_USER_COOKIE, xp_user_cookie_create($customerId, $sessionVersion), [
        'expires' => time() + XP_USER_TTL, 'path' => '/', 'secure' => xp_is_https(), 'httponly' => true, 'samesite' => 'Strict',
    ]);
}

function xp_customer_public(array $c): array
{
    return ['id' => $c['id'], 'email' => $c['email'], 'name' => $c['name'], 'verified' => !empty($c['email_verified_at']),
        'phone' => $c['phone'] ?? '', 'company' => $c['company'] ?? '', 'createdAt' => (int) $c['created_at'],
        'billing' => json_decode($c['billing_json'] ?? '{}', true) ?: new stdClass()];
}

function xp_count_events(string $type, string $where, array $params, int $seconds): int
{
    $row = xp_one("SELECT COUNT(*) AS n FROM events WHERE type = ? AND $where AND created_at > ?", array_merge([$type], $params, [time() - $seconds]));
    return (int) $row['n'];
}

// ---------------------------------------------------------------- rutas
function xp_route_portal(string $method, string $route): void
{
    if (strpos($route, 'oauth/') === 0) { xp_route_oauth($method, $route); }
    if ($route === 'plans' && $method === 'GET') {
$who = xp_current_customer();
        xp_json(200, [
            'ok' => true,
            'plans' => xp_plans($who),
            'tier' => null,
            'trialAvailable' => $who ? xp_trial_available($who) : null,
            'trialDays' => 14,
            'paymentMode' => xp_config()['payment_mode'] ?? 'manual',
            'payment' => (xp_config()['payment_mode'] ?? 'manual') === 'culqi' ? xp_culqi_public_info() : null,
        ]);
    }
    if ($route === 'lead' && $method === 'POST') {
        xp_portal_lead();
    }
    if ($route === 'download' && $method === 'GET') {
        $info = xp_installer_info();
        xp_json(200, ['ok' => true, 'installer' => $info]);
    }
    if ($route === 'verify' && $method === 'POST') {
        xp_portal_verify();
    }
    if ($route === 'forgot' && $method === 'POST') {
        xp_portal_forgot();
    }
    if ($route === 'reset' && $method === 'POST') {
        xp_portal_reset();
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
        xp_json(200, ['ok' => true, 'customer' => xp_customer_public($customer), 'verificationRequired' => xp_verification_required()]);
    }
    if ($route === 'profile' && $method === 'PATCH') { xp_portal_profile($customer); }
    if ($route === 'trial' && $method === 'POST') { xp_portal_start_trial($customer); }
    if ($route === 'password' && $method === 'POST') { xp_portal_password($customer); }
    if ($route === 'cards' && $method === 'GET') { xp_portal_cards($customer); }
    if ($route === 'cards' && $method === 'POST') { xp_portal_save_card($customer); }
    if (count($parts) === 2 && $parts[0] === 'cards' && $method === 'DELETE') { xp_portal_delete_card($customer, $parts[1]); }
    if ($route === 'resend-verification' && $method === 'POST') {
        xp_portal_resend($customer);
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
    if (count($parts) === 3 && $parts[0] === 'orders' && $parts[2] === 'pay' && $method === 'POST') {
        xp_portal_pay_order($customer, $parts[1]);
    }
    if (count($parts) === 3 && $parts[0] === 'orders' && $parts[2] === 'cancel' && $method === 'POST') {
        xp_portal_cancel_order($customer, $parts[1]);
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
        $name = xp_clip(explode('@', $email, 2)[0], 120);
    }
    if (xp_is_disposable_email($email)) {
        xp_json(400, ['ok' => false, 'error' => 'Use un correo personal o de su empresa; los correos temporales no se aceptan.']);
    }
    if (strlen($password) < 8 || strlen($password) > 200) {
        xp_json(400, ['ok' => false, 'error' => 'La contraseña debe tener al menos 8 caracteres.']);
    }
    $norm = xp_normalize_email($email);
    if (xp_one('SELECT id FROM customers WHERE email = ? OR email_norm = ?', [$email, $norm])) {
        xp_json(409, ['ok' => false, 'error' => 'Ya existe una cuenta con ese correo. Inicie sesión.']);
    }
    $id = xp_uuid();
    $needsVerification = xp_verification_required();
    xp_exec(
        'INSERT INTO customers (id, email, email_norm, name, password_hash, created_at, email_verified_at, session_version) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
        [$id, $email, $norm, $name, password_hash($password, PASSWORD_DEFAULT), time(), $needsVerification ? null : time()]
    );
    xp_log_event('portal_register', null, null, $email, $ip);
    $customer = xp_one('SELECT * FROM customers WHERE id = ?', [$id]);
    $sent = $needsVerification ? xp_send_verification($customer) : null;
    xp_set_user_cookie($id, 0);
    xp_json(201, ['ok' => true, 'customer' => xp_customer_public($customer), 'verificationRequired' => $needsVerification, 'verificationSent' => $sent]);
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
    $adminIdentity = $email !== '' && $email === xp_admin_login_email();
    if ($adminIdentity) {
        xp_admin_login_limit($ip);
        if ($password !== '' && password_verify($password, xp_config()['admin_password_hash'])) {
            if (($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'bimflow') {
                xp_json(403, ['ok' => false, 'error' => 'csrf']);
            }
            xp_admin_start_session();
            setcookie(XP_USER_COOKIE, '', ['expires' => 1, 'path' => '/', 'httponly' => true, 'samesite' => 'Strict']);
            xp_json(200, ['ok' => true, 'role' => 'admin', 'redirect' => '/admin/']);
        }
    }
    $c = $email !== '' ? xp_one('SELECT * FROM customers WHERE email = ?', [$email]) : null;
    // Se verifica siempre una contraseña para que el tiempo de respuesta no delate si el correo existe.
    $hash = $c['password_hash'] ?? password_hash('no-existe', PASSWORD_DEFAULT);
    if (!password_verify($password, $hash) || !$c) {
        if ($adminIdentity) { xp_log_event('admin_login_failed', null, null, '', $ip); }
        xp_log_event('portal_login_failed', null, null, $emailKey, $ip);
        xp_json(401, ['ok' => false, 'error' => 'Correo o contraseña incorrectos.']);
    }
    xp_set_user_cookie($c['id'], (int) ($c['session_version'] ?? 0));
    setcookie(XP_COOKIE, '', ['expires' => 1, 'path' => '/', 'httponly' => true, 'samesite' => 'Strict']);
    xp_json(200, ['ok' => true, 'customer' => xp_customer_public($c), 'verificationRequired' => xp_verification_required()]);
}

function xp_portal_license_row(array $customer): ?array
{
    return xp_one('SELECT * FROM licenses WHERE customer_id = ? ORDER BY created_at DESC LIMIT 1', [$customer['id']]);
}

function xp_portal_license(array $customer): void
{
    xp_ensure_free_license($customer);
    $lic = xp_portal_license_row($customer);
    if ($lic) { $lic = xp_refresh_access($lic); }
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
    $public['accessMode'] = $lic['access_mode'] ?? 'paid';
    $public['monthlyLimit'] = $public['accessMode'] === 'free' ? 150 : 0;
    $public['exportsUsed'] = xp_monthly_usage($lic['id']);
    $public['usageResetsAt'] = xp_monthly_reset();
    xp_json(200, ['ok' => true, 'license' => $public]);
}

function xp_order_public(array $o): array
{
    return [
        'code' => $o['code'], 'planName' => $o['plan_name'], 'amountCents' => (int) $o['amount_cents'], 'currency' => $o['currency'],
        'status' => $o['status'], 'kind' => $o['kind'], 'createdAt' => (int) $o['created_at'],
        'seconds' => (int) $o['seconds'], 'devices' => (int) $o['devices'],
        'paidAt' => $o['paid_at'] === null ? null : (int) $o['paid_at'],
        'canPay' => $o['status'] === 'pending' && xp_order_offer_current($o),
    ];
}

function xp_order_offer_current(array $order): bool
{
    foreach (xp_plans() as $plan) {
        if ($plan['id'] === $order['plan_id'] && empty($plan['free']) && $plan['priceCents'] === (int) $order['amount_cents']
            && $plan['devices'] === (int) $order['devices'] && $plan['seconds'] === (int) $order['seconds'] && $plan['currency'] === $order['currency']) { return true; }
    }
    return false;
}

function xp_portal_orders(array $customer): void
{
    $rows = xp_all('SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50', [$customer['id']]);
    xp_json(200, ['ok' => true, 'orders' => array_map('xp_order_public', $rows)]);
}

function xp_portal_create_order(array $customer): void
{
    if (xp_verification_required() && empty($customer['email_verified_at'])) {
        xp_json(403, ['ok' => false, 'code' => 'unverified', 'error' => 'Confirma tu correo para continuar. Te enviamos un enlace al registrarte.']);
    }
    $b = xp_body() ?? [];
    $plan = null;
    foreach (xp_plans($customer) as $p) {
        if ($p['id'] === ($b['planId'] ?? null)) {
            $plan = $p;
        }
    }
    if (!$plan) {
        xp_json(400, ['ok' => false, 'error' => 'Plan no disponible.']);
    }
    if (!empty($plan['free'])) {
        xp_ensure_free_license($customer);
        xp_json(409, ['ok' => false, 'error' => 'Xport Gratuito se incluye automáticamente al confirmar tu cuenta. Consulta Licencia y equipos.']);
    } else {
        $pending = (int) xp_one("SELECT COUNT(*) AS n FROM orders WHERE customer_id = ? AND status = 'pending'", [$customer['id']])['n'];
        if ($pending >= XP_MAX_PENDING_ORDERS) {
            xp_json(409, ['ok' => false, 'error' => 'Ya tiene pedidos pendientes de pago. Espere su confirmación o cancélelos con soporte.']);
        }
    }
    $kind = xp_portal_license_row($customer) ? 'renew' : 'new';
    $id = xp_uuid();
    $code = 'BF-' . substr(strtoupper(strtr(base64_encode(random_bytes(6)), '+/=', 'XYZ')), 0, 6);
    $mode = xp_config()['payment_mode'] ?? 'manual';
    if ($mode === 'culqi' && !$plan['trial'] && !xp_culqi_enabled()) {
        xp_json(503, ['ok' => false, 'error' => 'Los pagos en línea no están disponibles por ahora. Inténtalo más tarde.']);
    }
    xp_exec(
        "INSERT INTO orders (id, code, customer_id, plan_id, plan_name, seconds, devices, kind, amount_cents, currency, status, provider, tier, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
        [$id, $code, $customer['id'], $plan['id'], $plan['name'], $plan['seconds'], $plan['devices'], $kind, $plan['priceCents'], $plan['currency'], $mode, 0, time()]
    );
    xp_log_event('order_created', null, null, $code . ' · ' . $plan['name'] . ' · ' . $customer['email']);
    $paid = false;
    if ($mode === 'test') { $paid = xp_mark_order_paid($id, 'modo de prueba') !== null; }
    $order = xp_one('SELECT * FROM orders WHERE id = ?', [$id]);
    $online = !$paid && $mode === 'culqi';
    if (!$paid && !$online) {
        xp_notify_order_pending($customer, $order);
    }
    xp_json(201, [
        'ok' => true,
        'paid' => $paid,
        'order' => xp_order_public($order),
        'payment' => $online ? array_merge((array) xp_culqi_public_info(), [
            'amount' => (int) $order['amount_cents'],
            'currency' => $order['currency'],
            'description' => mb_substr('Xport · ' . $order['plan_name'], 0, 80),
            'orderCode' => $order['code'],
        ]) : null,
        'instructions' => ($paid || $online) ? '' : (string) (xp_config()['payment_instructions']
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

// ---------------------------------------------------------------- verificación de correo y recuperación de contraseña
/** Se exige verificar el correo solo si el servidor puede enviarlo (hay SMTP y URL pública). */
function xp_verification_required(): bool
{
    return xp_mail_enabled() && xp_base_url() !== '' && (bool) (xp_config()['require_email_verification'] ?? true);
}

function xp_money_text(int $cents, string $currency): string
{
    $symbol = $currency === 'PEN' ? 'S/' : $currency;
    return $symbol . ' ' . number_format($cents / 100, $cents % 100 === 0 ? 0 : 2, '.', ',');
}

/** Crea un enlace de un solo uso (se guarda su huella, no el valor) e invalida los anteriores del mismo tipo. */
function xp_token_create(string $customerId, string $type, int $ttl): string
{
    xp_exec('UPDATE email_tokens SET used_at = ? WHERE customer_id = ? AND type = ? AND used_at IS NULL', [time(), $customerId, $type]);
    $raw = xp_b64u_enc(random_bytes(32));
    xp_exec(
        'INSERT INTO email_tokens (id, customer_id, type, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [xp_uuid(), $customerId, $type, xp_sha256($raw), time() + $ttl, time()]
    );
    return $raw;
}

/** @return array<string,mixed>|null */
function xp_token_row(string $raw, string $type): ?array
{
    if ($raw === '' || strlen($raw) > 100) {
        return null;
    }
    return xp_one('SELECT * FROM email_tokens WHERE token_hash = ? AND type = ?', [xp_sha256($raw), $type]);
}

function xp_send_verification(array $customer): bool
{
    $base = xp_base_url();
    if ($base === '') {
        return false;
    }
    $token = xp_token_create($customer['id'], 'verify', 2 * XP_DAY);
    xp_log_event('verify_sent', null, null, $customer['id'], xp_ip());
    return xp_send_mail(
        $customer['email'],
        'Confirma tu correo en Xport',
        xp_mail_template(
            'Confirma tu correo',
            '<p>Hola ' . htmlspecialchars($customer['name']) . ',</p><p>Gracias por crear tu cuenta en Xport. Confirma tu correo para activar tu prueba gratuita y gestionar tu licencia.</p><p>El enlace vale 48 horas.</p>',
            $base . '/portal/#verify=' . $token,
            'Confirmar mi correo'
        )
    );
}

function xp_portal_verify(): void
{
    $b = xp_body() ?? [];
    $row = xp_token_row(is_string($b['token'] ?? null) ? $b['token'] : '', 'verify');
    $c = $row ? xp_one('SELECT * FROM customers WHERE id = ?', [$row['customer_id']]) : null;
    if (!$row || !$c) {
        xp_json(400, ['ok' => false, 'error' => 'El enlace no es válido. Pide uno nuevo desde tu cuenta.']);
    }
    if (!empty($c['email_verified_at'])) {
        xp_json(200, ['ok' => true, 'alreadyVerified' => true]);
    }
    if ($row['used_at'] !== null || (int) $row['expires_at'] < time()) {
        xp_json(400, ['ok' => false, 'error' => 'El enlace venció. Inicia sesión y pide uno nuevo.']);
    }
    xp_exec('UPDATE email_tokens SET used_at = ? WHERE id = ?', [time(), $row['id']]);
    xp_exec('UPDATE customers SET email_verified_at = ? WHERE id = ?', [time(), $c['id']]);
    xp_log_event('email_verified', null, null, $c['email']);
    xp_json(200, ['ok' => true]);
}

function xp_portal_resend(array $customer): void
{
    if (!empty($customer['email_verified_at'])) {
        xp_json(200, ['ok' => true, 'alreadyVerified' => true]);
    }
    if (!xp_verification_required()) {
        xp_json(503, ['ok' => false, 'error' => 'El envío de correos no está disponible por ahora. Contacta a soporte.']);
    }
    if (xp_count_events('verify_sent', 'detail = ?', [$customer['id']], 3600) >= 3) {
        xp_json(429, ['ok' => false, 'error' => 'Ya te enviamos varios correos. Revisa tu bandeja y la carpeta de spam, o inténtalo en una hora.']);
    }
    $ok = xp_send_verification($customer);
    xp_json($ok ? 200 : 502, $ok ? ['ok' => true] : ['ok' => false, 'error' => 'No pudimos enviar el correo. Inténtalo de nuevo en unos minutos.']);
}

function xp_portal_forgot(): void
{
    $ip = xp_ip();
    $b = xp_body() ?? [];
    $email = strtolower(xp_clip($b['email'] ?? '', 160));
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        xp_json(400, ['ok' => false, 'error' => 'Ingresa un correo válido.']);
    }
    $emailKey = substr(xp_sha256($email), 0, 16);
    if (($ip !== '' && xp_count_events('forgot_requested', 'ip = ?', [$ip], 3600) >= 5) || xp_count_events('forgot_requested', 'detail = ?', [$emailKey], 3600) >= 3) {
        xp_json(429, ['ok' => false, 'error' => 'Demasiadas solicitudes. Inténtalo de nuevo en una hora.']);
    }
    xp_log_event('forgot_requested', null, null, $emailKey, $ip);
    $c = xp_one('SELECT * FROM customers WHERE email = ?', [$email]);
    $base = xp_base_url();
    if ($c && xp_mail_enabled() && $base !== '') {
        $token = xp_token_create($c['id'], 'reset', 3600);
        xp_send_mail(
            $c['email'],
            'Restablece tu contraseña de Xport',
            xp_mail_template(
                'Restablece tu contraseña',
                '<p>Hola ' . htmlspecialchars($c['name']) . ',</p><p>Recibimos una solicitud para restablecer la contraseña de tu cuenta. El enlace vale 1 hora y solo se puede usar una vez.</p><p>Si no fuiste tú, ignora este correo: tu contraseña no cambiará.</p>',
                $base . '/portal/#reset=' . $token,
                'Crear una contraseña nueva'
            )
        );
    }
    // Misma respuesta exista o no la cuenta, para no revelar quién está registrado.
    xp_json(200, ['ok' => true, 'message' => 'Si existe una cuenta con ese correo, te enviamos un enlace para restablecer la contraseña. Revisa también la carpeta de spam.']);
}

function xp_portal_reset(): void
{
    $ip = xp_ip();
    if ($ip !== '' && xp_count_events('reset_failed', 'ip = ?', [$ip], 3600) >= 10) {
        xp_json(429, ['ok' => false, 'error' => 'Demasiados intentos. Inténtalo más tarde.']);
    }
    $b = xp_body() ?? [];
    $password = is_string($b['password'] ?? null) ? $b['password'] : '';
    if (strlen($password) < 8 || strlen($password) > 200) {
        xp_json(400, ['ok' => false, 'error' => 'La contraseña debe tener al menos 8 caracteres.']);
    }
    $row = xp_token_row(is_string($b['token'] ?? null) ? $b['token'] : '', 'reset');
    $c = $row ? xp_one('SELECT * FROM customers WHERE id = ?', [$row['customer_id']]) : null;
    if (!$row || !$c || $row['used_at'] !== null || (int) $row['expires_at'] < time()) {
        xp_log_event('reset_failed', null, null, '', $ip);
        xp_json(400, ['ok' => false, 'error' => 'El enlace no es válido o venció. Pide uno nuevo.']);
    }
    xp_tx(function () use ($row, $c, $password) {
        xp_exec('UPDATE email_tokens SET used_at = ? WHERE customer_id = ? AND type = ? AND used_at IS NULL', [time(), $c['id'], 'reset']);
        xp_exec(
            'UPDATE customers SET password_hash = ?, session_version = session_version + 1, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?',
            [password_hash($password, PASSWORD_DEFAULT), time(), $c['id']]
        );
    });
    xp_log_event('password_reset', null, null, $c['email'], $ip);
    xp_send_mail(
        $c['email'],
        'Tu contraseña de Xport fue cambiada',
        xp_mail_template(
            'Tu contraseña fue cambiada',
            '<p>Hola ' . htmlspecialchars($c['name']) . ',</p><p>La contraseña de tu cuenta se cambió el ' . gmdate('d/m/Y H:i') . ' (UTC). Las sesiones abiertas se cerraron.</p><p><b>Si no fuiste tú</b>, restablece tu contraseña de nuevo ahora mismo y escríbenos.</p>',
            xp_base_url() !== '' ? xp_base_url() . '/portal/' : null,
            'Ir a mi cuenta'
        )
    );
    xp_json(200, ['ok' => true]);
}

// ---------------------------------------------------------------- avisos de pedidos
function xp_notify_order_pending(array $customer, array $order): void
{
    $base = xp_base_url();
    $amount = xp_money_text((int) $order['amount_cents'], $order['currency']);
    $instructions = (string) (xp_config()['payment_instructions'] ?? '');
    xp_send_mail(
        $customer['email'],
        'Recibimos tu pedido ' . $order['code'],
        xp_mail_template(
            'Recibimos tu pedido',
            '<p>Hola ' . htmlspecialchars($customer['name']) . ',</p><p>Pedido <b>' . htmlspecialchars($order['code']) . '</b>: plan ' . htmlspecialchars($order['plan_name']) . ' por <b>' . htmlspecialchars($amount) . '</b>.</p>'
            . ($instructions !== '' ? '<p>' . htmlspecialchars($instructions) . '</p>' : '') . '<p>Te avisaremos por correo cuando confirmemos el pago y tu licencia esté lista.</p>',
            $base !== '' ? $base . '/portal/' : null,
            'Ver mi pedido'
        )
    );
    $admin = (string) (xp_config()['admin_email'] ?? '');
    if ($admin !== '') {
        xp_send_mail(
            $admin,
            'Nuevo pedido por aprobar: ' . $order['code'],
            xp_mail_template(
                'Nuevo pedido por aprobar',
                '<p><b>' . htmlspecialchars($customer['name']) . '</b> (' . htmlspecialchars($customer['email']) . ') pidió el plan ' . htmlspecialchars($order['plan_name']) . ' por <b>' . htmlspecialchars($amount) . '</b>.</p><p>Código de pedido: <b>' . htmlspecialchars($order['code']) . '</b>. Apruébalo en el panel cuando recibas el pago.</p>',
                $base !== '' ? $base . '/admin/' : null,
                'Abrir el panel'
            )
        );
    }
}

function xp_notify_license_ready(string $orderId): void
{
    $o = xp_one('SELECT * FROM orders WHERE id = ?', [$orderId]);
    $c = $o ? xp_one('SELECT * FROM customers WHERE id = ?', [$o['customer_id']]) : null;
    $lic = $o && $o['license_id'] ? xp_one('SELECT expires_at FROM licenses WHERE id = ?', [$o['license_id']]) : null;
    if (!$o || !$c || !$lic) {
        return;
    }
    $base = xp_base_url();
    $trial = $o['kind'] === 'trial';
    xp_send_mail(
        $c['email'],
        $trial ? 'Tu prueba gratis de Xport está activa' : 'Tu licencia de Xport está lista',
        xp_mail_template(
            $trial ? 'Tu prueba gratis está activa' : 'Tu licencia está lista',
            '<p>Hola ' . htmlspecialchars($c['name']) . ',</p><p>' . ($trial ? 'Tu prueba gratuita ya está activa.' : 'Confirmamos tu pago del pedido <b>' . htmlspecialchars($o['code']) . '</b>.')
            . ' Tu licencia vence el <b>' . gmdate('d/m/Y', (int) $lic['expires_at']) . '</b>.</p><p>Entra a tu cuenta para ver tu clave, instalar el plugin y activarlo en Revit.</p>',
            $base !== '' ? $base . '/portal/' : null,
            'Ver mi licencia'
        )
    );
}

// ---------------------------------------------------------------- instalador publicado para los clientes
function xp_downloads_dir(): string
{
    return rtrim((string) ($_SERVER['DOCUMENT_ROOT'] ?? ''), '/\\') . '/downloads';
}

/** @return array<string,mixed>|null */
function xp_installer_info(): ?array
{
    $dir = xp_downloads_dir();
    $meta = @file_get_contents($dir . '/installer.json');
    $data = $meta ? json_decode($meta, true) : null;
    $filename = is_array($data) && ($data['file'] ?? '') === 'Xport_Setup.exe' ? 'Xport_Setup.exe' : 'XportBIM_Setup.exe';
    $file = $dir . '/' . $filename;
    if (!is_array($data) || !is_file($file)) {
        return null;
    }
    return [
        'url' => '/downloads/' . $filename,
        'version' => (string) ($data['version'] ?? ''),
        'size' => (int) filesize($file),
        'sha256' => (string) ($data['sha256'] ?? ''),
        'uploadedAt' => (int) ($data['uploadedAt'] ?? 0),
    ];
}

// ---------------------------------------------------------------- cobro en línea (Culqi)
function xp_portal_pay_order(array $customer, string $code): void
{
    if ((xp_config()['payment_mode'] ?? 'manual') !== 'culqi' || !xp_culqi_enabled()) {
        xp_json(400, ['ok' => false, 'error' => 'Los pagos en línea no están activos.']);
    }
    if (xp_verification_required() && empty($customer['email_verified_at'])) {
        xp_json(403, ['ok' => false, 'code' => 'unverified', 'error' => 'Confirma tu correo para continuar.']);
    }
    $b = xp_body() ?? [];
    $token = is_string($b['token'] ?? null) ? trim($b['token']) : '';
    if (!empty($b['cardId'])) {
        $card = xp_one('SELECT provider_id FROM payment_methods WHERE id = ? AND customer_id = ? AND environment = ?', [xp_clip($b['cardId'], 36), $customer['id'], xp_culqi_environment()]);
        if (!$card) { xp_json(404, ['ok' => false, 'error' => 'Tarjeta no encontrada.']); }
        $token = $card['provider_id'];
    } elseif (!preg_match('/^tkn_' . xp_culqi_environment() . '_[A-Za-z0-9]{4,80}$/', $token)) {
        xp_json(400, ['ok' => false, 'error' => 'No se recibió el medio de pago. Inténtalo de nuevo.']);
    }
    // El monto y la moneda salen SIEMPRE del pedido guardado: lo que mande el navegador no cuenta.
    $order = xp_one('SELECT * FROM orders WHERE code = ? AND customer_id = ?', [$code, $customer['id']]);
    if (!$order) {
        xp_json(404, ['ok' => false, 'error' => 'Pedido no encontrado.']);
    }
    if ($order['status'] === 'processing') {
        xp_json(409, ['ok' => false, 'error' => 'Estamos verificando el pago de este pedido. No lo repitas: te avisaremos cuando se confirme.']);
    }
    if ($order['status'] !== 'pending') {
        xp_json(409, ['ok' => false, 'error' => 'Este pedido ya no está pendiente.']);
    }
    if (!xp_order_offer_current($order)) {
        xp_json(409, ['ok' => false, 'error' => 'Este pedido corresponde a una tarifa anterior. Cancélalo y elige un plan con los precios actuales.']);
    }
    if (xp_count_events('payment_attempt', 'detail = ?', [$code], 3600) >= 5) {
        xp_json(429, ['ok' => false, 'error' => 'Demasiados intentos de pago para este pedido. Inténtalo en una hora o contacta a soporte.']);
    }
    // Se "reserva" el pedido de forma atómica: dos clics o dos pestañas no pueden cobrar dos veces.
    if (xp_exec("UPDATE orders SET status = 'processing', claimed_at = ? WHERE id = ? AND status = 'pending'", [time(), $order['id']]) !== 1) {
        xp_json(409, ['ok' => false, 'error' => 'Este pedido ya se está procesando.']);
    }
    xp_log_event('payment_attempt', null, null, $code, xp_ip());
    try {
        $r = xp_culqi_charge($order, $customer, $token);
    } catch (Throwable $e) {
        error_log('[xportbim-culqi] ' . $e->getMessage());
        $r = ['ok' => false, 'definitive' => false, 'chargeId' => '', 'message' => ''];
    }
    if ($r['ok']) {
        try {
            xp_mark_order_paid($order['id'], 'Culqi', $r['chargeId']);
            xp_log_event('payment_charged', null, null, $code . ' · ' . $r['chargeId']);
        } catch (Throwable $e) {
            // Cobrado pero sin registrar: el pedido queda "en proceso" con el cargo anotado para que el administrador lo apruebe.
            error_log('[xportbim-culqi] cobrado ' . $r['chargeId'] . ' pero no se pudo registrar: ' . $e->getMessage());
            xp_exec('UPDATE orders SET provider_ref = ? WHERE id = ?', [$r['chargeId'], $order['id']]);
            xp_log_event('payment_paid_not_recorded', null, null, $code . ' · ' . $r['chargeId']);
            xp_json(500, ['ok' => false, 'error' => 'Tu pago se recibió pero hubo un problema al activarlo. Lo resolveremos de inmediato; no lo repitas.']);
        }
        $paid = xp_one('SELECT * FROM orders WHERE id = ?', [$order['id']]);
        xp_json(200, ['ok' => true, 'paid' => true, 'order' => xp_order_public($paid)]);
    }
    if ($r['definitive']) {
        xp_exec("UPDATE orders SET status = 'pending', claimed_at = NULL WHERE id = ?", [$order['id']]);
        xp_log_event('payment_failed', null, null, $code . ' · ' . $r['message']);
        xp_json(402, ['ok' => false, 'error' => $r['message']]);
    }
    // Sin respuesta clara: no se sabe si se cobró. Se deja en revisión para NO cobrar dos veces.
    if ($r['chargeId'] !== '') {
        xp_exec('UPDATE orders SET provider_ref = ? WHERE id = ?', [$r['chargeId'], $order['id']]);
    }
    xp_log_event('payment_unknown', null, null, $code . ($r['chargeId'] !== '' ? ' · ' . $r['chargeId'] : ''));
    xp_json(502, ['ok' => false, 'pending' => true, 'error' => 'No pudimos confirmar el pago con el banco. Si ves el cargo en tu tarjeta, no lo repitas: lo verificaremos y activaremos tu licencia.']);
}

function xp_portal_cancel_order(array $customer, string $code): void
{
    $n = xp_exec("UPDATE orders SET status = 'cancelled' WHERE code = ? AND customer_id = ? AND status = 'pending'", [$code, $customer['id']]);
    if ($n === 0) {
        xp_json(409, ['ok' => false, 'error' => 'Solo se pueden cancelar los pedidos pendientes de pago.']);
    }
    xp_log_event('order_cancelled_by_customer', null, null, $code);
    xp_json(200, ['ok' => true]);
}
