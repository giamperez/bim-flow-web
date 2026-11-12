<?php
declare(strict_types=1);

const XP_OAUTH_COOKIE = 'xp_oauth_state';

function xp_oauth_config(string $provider): ?array
{
    if (!in_array($provider, ['google', 'microsoft'], true)) { return null; }
    $c = xp_config()['oauth'][$provider] ?? [];
    if (empty($c['client_id']) || empty($c['client_secret'])) { return null; }
    $tenant = strtolower((string) ($c['tenant'] ?? 'common'));
    if (!preg_match('/^(common|organizations|consumers|[a-f0-9-]{36})$/i', $tenant)) { return null; }
    $base = rtrim((string) (xp_config()['public_url'] ?? ''), '/');
    if (!preg_match('#^https://[^/]+$#', $base) && !preg_match('#^http://127\.0\.0\.1:\d+$#', $base)) { return null; }
    $endpoints = $provider === 'google'
        ? ['authorize' => 'https://accounts.google.com/o/oauth2/v2/auth', 'token' => 'https://oauth2.googleapis.com/token', 'keys' => 'https://www.googleapis.com/oauth2/v3/certs']
        : ['authorize' => "https://login.microsoftonline.com/$tenant/oauth2/v2.0/authorize", 'token' => "https://login.microsoftonline.com/$tenant/oauth2/v2.0/token", 'keys' => 'https://login.microsoftonline.com/common/discovery/v2.0/keys'];
    // Local fake issuer is permitted only in an explicitly configured loopback QA environment.
    $test = xp_config()['oauth']['test_base'] ?? '';
    if (preg_match('#^http://127\.0\.0\.1:\d+$#', $base) && preg_match('#^http://127\.0\.0\.1:\d+/oidc$#', $test)) {
        foreach ($endpoints as $key => $_) { $endpoints[$key] = "$test/$provider/$key"; }
    }
    return array_merge($c, $endpoints, ['tenant' => $tenant, 'redirect_uri' => "$base/portal/api/oauth/$provider/callback"]);
}

function xp_oauth_cookie(string $state): void
{
    setcookie(XP_OAUTH_COOKIE, $state, ['expires' => $state === '' ? 1 : time() + 600,
        'path' => '/portal/api/oauth/', 'secure' => xp_is_https(), 'httponly' => true, 'samesite' => 'Lax']);
}

function xp_oauth_error(string $code): void
{
    xp_oauth_cookie('');
    header('Cache-Control: no-store');
    header('Location: /portal/?sso_error=' . rawurlencode($code), true, 303);
    exit;
}

function xp_route_oauth(string $method, string $route): void
{
    if ($route === 'oauth/providers' && $method === 'GET') {
        $providers = array_values(array_filter(['google', 'microsoft'], fn($p) => xp_oauth_config($p) !== null));
        xp_json(200, ['ok' => true, 'providers' => $providers]);
    }
    if (!preg_match('#^oauth/(google|microsoft)/(start|callback)$#', $route, $m) || $method !== 'GET') {
        xp_json(404, ['ok' => false, 'error' => 'not_found']);
    }
    $provider = $m[1]; $c = xp_oauth_config($provider);
    if (!$c) { xp_oauth_error('unavailable'); }
    if ($m[2] === 'start') {
        $ip = xp_ip();
        if ($ip !== '' && xp_count_events('oauth_start', 'ip = ?', [$ip], 600) >= 30) { xp_oauth_error('limited'); }
        $state = xp_b64u_enc(random_bytes(32)); $verifier = xp_b64u_enc(random_bytes(48)); $nonce = xp_b64u_enc(random_bytes(32));
        $next = xp_clip($_GET['next'] ?? '', 24);
        if (!in_array($next, ['comprar', 'prueba', 'resumen'], true)) { $next = ''; }
        xp_exec('DELETE FROM oauth_flows WHERE expires_at < ?', [time()]);
        xp_exec('INSERT INTO oauth_flows (state_hash, provider, verifier, nonce, next_view, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
            [xp_sha256($state), $provider, $verifier, $nonce, $next, time() + 600]);
        xp_oauth_cookie($state); xp_log_event('oauth_start', null, null, $provider, $ip);
        $query = ['client_id' => $c['client_id'], 'redirect_uri' => $c['redirect_uri'], 'response_type' => 'code', 'response_mode' => 'query',
            'scope' => 'openid profile email', 'state' => $state, 'nonce' => $nonce,
            'code_challenge' => xp_b64u_enc(hash('sha256', $verifier, true)), 'code_challenge_method' => 'S256', 'prompt' => 'select_account'];
        header('Cache-Control: no-store'); header('Location: ' . $c['authorize'] . '?' . http_build_query($query)); exit;
    }
    $state = xp_clip($_GET['state'] ?? '', 100); $cookie = $_COOKIE[XP_OAUTH_COOKIE] ?? '';
    if ($state === '' || !is_string($cookie) || !hash_equals($cookie, $state)) { xp_oauth_error('invalid_state'); }
    $flow = xp_tx(function () use ($state, $provider) {
        $r = xp_one('SELECT * FROM oauth_flows WHERE state_hash = ?' . xp_for_update(), [xp_sha256($state)]);
        if (!$r || $r['provider'] !== $provider || (int) $r['expires_at'] < time()) { return null; }
        xp_exec('DELETE FROM oauth_flows WHERE state_hash = ?', [xp_sha256($state)]);
        return $r;
    });
    xp_oauth_cookie('');
    if (!$flow) { xp_oauth_error('invalid_state'); }
    if (isset($_GET['error'])) { xp_oauth_error('cancelled'); }
    $code = xp_clip($_GET['code'] ?? '', 4096);
    if ($code === '') { xp_oauth_error('invalid_response'); }
    try {
        $token = xp_oauth_http($c['token'], ['client_id' => $c['client_id'], 'client_secret' => $c['client_secret'],
            'grant_type' => 'authorization_code', 'code' => $code, 'redirect_uri' => $c['redirect_uri'], 'code_verifier' => $flow['verifier']]);
        $claims = xp_oauth_verify((string) ($token['id_token'] ?? ''), $provider, $c, $flow['nonce']);
        if (!$claims) { xp_oauth_error('invalid_response'); }
        // Only Google's verified address is trusted for the administrator; Microsoft claims are never used for this.
        $adminEmail = xp_admin_login_email();
        if ($provider === 'google' && $adminEmail !== '' && ($claims['email_verified'] ?? false) === true
            && strtolower((string) ($claims['email'] ?? '')) === $adminEmail) {
            xp_admin_start_session();
            setcookie(XP_USER_COOKIE, '', ['expires' => 1, 'path' => '/', 'httponly' => true, 'samesite' => 'Strict']);
            header('Cache-Control: no-store'); header('Location: /admin/', true, 303); exit;
        }
        $result = xp_oauth_customer($provider, $claims);
        if (isset($result['error'])) { xp_oauth_error($result['error']); }
        if (!empty($result['created']) && $provider === 'microsoft' && xp_verification_required()) {
            xp_send_verification(xp_one('SELECT * FROM customers WHERE id = ?', [$result['id']]));
        }
        xp_set_user_cookie($result['id'], (int) $result['session_version']);
        setcookie(XP_COOKIE, '', ['expires' => 1, 'path' => '/', 'httponly' => true, 'samesite' => 'Strict']);
        xp_log_event('oauth_login', null, null, $provider, xp_ip());
        header('Cache-Control: no-store'); header('Location: /portal/' . ($flow['next_view'] ? '#' . $flow['next_view'] : ''), true, 303); exit;
    } catch (Throwable $e) {
        // Do not log authorization codes, tokens or provider responses.
        xp_log_event('oauth_failed', null, null, $provider, xp_ip());
        xp_oauth_error('unavailable');
    }
}

function xp_oauth_http(string $url, ?array $form = null): array
{
    $headers = ['Accept: application/json'];
    if ($form !== null) { $headers[] = 'Content-Type: application/x-www-form-urlencoded'; }
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => $headers, CURLOPT_CONNECTTIMEOUT => 8,
            CURLOPT_TIMEOUT => 15, CURLOPT_FOLLOWLOCATION => false]);
        if ($form !== null) { curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => http_build_query($form)]); }
        $raw = curl_exec($ch); $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    } else {
        $ctx = stream_context_create(['http' => ['method' => $form === null ? 'GET' : 'POST', 'header' => implode("\r\n", $headers),
            'content' => $form === null ? '' : http_build_query($form), 'timeout' => 15, 'follow_location' => 0, 'ignore_errors' => true]]);
        $raw = @file_get_contents($url, false, $ctx); $status = 0;
        foreach (($http_response_header ?? []) as $h) { if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) { $status = (int) $m[1]; } }
    }
    $data = is_string($raw) ? json_decode($raw, true) : null;
    if ($status !== 200 || !is_array($data)) { throw new RuntimeException('oauth_http_failed'); }
    return $data;
}

function xp_oauth_der(int $tag, string $value): string
{
    $length = strlen($value);
    $len = $length < 128 ? chr($length) : ($length < 256 ? "\x81" . chr($length) : "\x82" . pack('n', $length));
    return chr($tag) . $len . $value;
}

function xp_oauth_verify(string $jwt, string $provider, array $c, string $nonce): ?array
{
    if (strlen($jwt) > 20000) { return null; }
    $parts = explode('.', $jwt);
    if (count($parts) !== 3) { return null; }
    [$head, $body, $sig] = $parts;
    $h = json_decode(xp_b64u_dec($head), true); $p = json_decode(xp_b64u_dec($body), true);
    if (!is_array($h) || !is_array($p) || ($h['alg'] ?? '') !== 'RS256' || empty($h['kid'])
        || !is_string($p['sub'] ?? null) || strlen($p['sub']) > 255 || $p['sub'] === ''
        || ($p['aud'] ?? '') !== $c['client_id'] || (int) ($p['exp'] ?? 0) <= time()
        || (isset($p['azp']) && $p['azp'] !== $c['client_id']) || !is_int($p['iat'] ?? null)
        || (int) ($p['iat'] ?? 0) > time() + 60 || (int) ($p['nbf'] ?? 0) > time() + 60
        || !is_string($p['nonce'] ?? null) || !hash_equals($nonce, $p['nonce'])) { return null; }
    if ($provider === 'google') {
        if (!in_array($p['iss'] ?? '', ['https://accounts.google.com', 'accounts.google.com'], true)) { return null; }
    } else {
        $tenant = $p['tid'] ?? '';
        if (!is_string($tenant) || !preg_match('/^[a-f0-9-]{36}$/i', $tenant) || ($p['iss'] ?? '') !== "https://login.microsoftonline.com/$tenant/v2.0") { return null; }
        if (!in_array($c['tenant'], ['common', 'organizations', 'consumers'], true) && strcasecmp($c['tenant'], $tenant) !== 0) { return null; }
        if ($c['tenant'] === 'consumers' && $tenant !== '9188040d-6c67-4c5b-b112-36a304b66dad') { return null; }
        if ($c['tenant'] === 'organizations' && $tenant === '9188040d-6c67-4c5b-b112-36a304b66dad') { return null; }
    }
    $keys = xp_oauth_http($c['keys']);
    foreach (($keys['keys'] ?? []) as $jwk) {
        if (($jwk['kid'] ?? '') !== $h['kid'] || ($jwk['kty'] ?? '') !== 'RSA' || ($jwk['use'] ?? 'sig') !== 'sig') { continue; }
        $n = xp_b64u_dec((string) ($jwk['n'] ?? '')); $e = xp_b64u_dec((string) ($jwk['e'] ?? ''));
        if ($n === '' || $e === '' || strlen($n) < 256 || strlen($n) > 1024) { return null; }
        if (ord($n[0]) & 128) { $n = "\0" . $n; } if (ord($e[0]) & 128) { $e = "\0" . $e; }
        $rsa = xp_oauth_der(48, xp_oauth_der(2, $n) . xp_oauth_der(2, $e));
        $spki = xp_oauth_der(48, hex2bin('300d06092a864886f70d0101010500') . xp_oauth_der(3, "\0" . $rsa));
        $pem = "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($spki), 64, "\n") . "-----END PUBLIC KEY-----\n";
        return openssl_verify($head . '.' . $body, xp_b64u_dec($sig), $pem, OPENSSL_ALGO_SHA256) === 1 ? $p : null;
    }
    return null;
}

function xp_oauth_customer(string $provider, array $claims): array
{
    return xp_tx(function () use ($provider, $claims) {
        $issuer = $provider === 'google' ? 'https://accounts.google.com' : $claims['iss'];
        $subject = xp_sha256($issuer . '|' . $claims['sub']);
        $identity = xp_one('SELECT customer_id FROM oauth_identities WHERE provider = ? AND subject_hash = ?', [$provider, $subject]);
        if ($identity) {
            return xp_one('SELECT id, session_version FROM customers WHERE id = ?', [$identity['customer_id']]) ?: ['error' => 'account_missing'];
        }
        $email = strtolower(xp_clip($claims['email'] ?? '', 160));
        if (!filter_var($email, FILTER_VALIDATE_EMAIL) || xp_is_disposable_email($email)
            || ($provider === 'google' && ($claims['email_verified'] ?? false) !== true)) { return ['error' => 'email_required']; }
        // An email match alone never links or elevates an existing account, especially Microsoft claims.
        if (xp_one('SELECT id FROM customers WHERE email = ? OR email_norm = ?', [$email, xp_normalize_email($email)])) { return ['error' => 'account_exists']; }
        if (xp_ip() !== '' && xp_count_events('portal_register', 'ip = ?', [xp_ip()], 3600) >= 10) { return ['error' => 'limited']; }
        $id = xp_uuid(); $name = xp_clip($claims['name'] ?? '', 120) ?: explode('@', $email)[0];
        $verified = $provider === 'google' ? time() : null;
        xp_exec('INSERT INTO customers (id, email, email_norm, name, password_hash, created_at, email_verified_at, session_version, password_set) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)',
            [$id, $email, xp_normalize_email($email), $name, password_hash(bin2hex(random_bytes(32)), PASSWORD_DEFAULT), time(), $verified]);
        xp_exec('INSERT INTO oauth_identities (provider, subject_hash, customer_id, created_at) VALUES (?, ?, ?, ?)', [$provider, $subject, $id, time()]);
        xp_log_event('portal_register', null, null, $email, xp_ip());
        return ['id' => $id, 'session_version' => 0, 'created' => true];
    });
}
