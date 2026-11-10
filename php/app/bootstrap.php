<?php
// Servidor de licencias XportBIM — versión PHP (Cloudways / Apache + PHP-FPM + MySQL o SQLite).
// Mismos endpoints y misma lógica que la versión Cloudflare Worker.
declare(strict_types=1);

const XP_DAY = 86400;
const XP_KEY_PREFIX = 'XPBM';
const XP_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// ---------------------------------------------------------------- config / db
function xp_config(): array
{
    static $config = null;
    if ($config === null) {
        $file = __DIR__ . '/config.php';
        if (!is_file($file)) {
            xp_json(500, ['ok' => false, 'error' => 'not_configured', 'message' => 'El servidor no está configurado. Ejecute: php app/bin/setup.php']);
        }
        $config = require $file;
    }
    return $config;
}

function xp_db(): PDO
{
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }
    $c = xp_config();
    if (($c['db']['driver'] ?? '') === 'sqlite') {
        $pdo = new PDO('sqlite:' . $c['db']['path']);
        $pdo->exec('PRAGMA foreign_keys = ON');
        $pdo->exec('PRAGMA busy_timeout = 5000');
    } else {
        $d = $c['db'];
        $pdo = new PDO(
            'mysql:host=' . $d['host'] . ';dbname=' . $d['name'] . ';charset=utf8mb4',
            $d['user'],
            $d['pass']
        );
    }
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    return $pdo;
}

function xp_is_sqlite(): bool
{
    return (xp_config()['db']['driver'] ?? '') === 'sqlite';
}

/** @return array<string,mixed>|null */
function xp_one(string $sql, array $params = []): ?array
{
    $st = xp_db()->prepare($sql);
    $st->execute($params);
    $row = $st->fetch();
    return $row === false ? null : $row;
}

function xp_all(string $sql, array $params = []): array
{
    $st = xp_db()->prepare($sql);
    $st->execute($params);
    return $st->fetchAll();
}

/** Executes a write and returns the number of affected rows. */
function xp_exec(string $sql, array $params = []): int
{
    $st = xp_db()->prepare($sql);
    $st->execute($params);
    return $st->rowCount();
}

/** Runs $fn inside a transaction; commits on return, rolls back on exception. */
function xp_tx(callable $fn)
{
    $pdo = xp_db();
    $pdo->beginTransaction();
    try {
        $result = $fn();
        $pdo->commit();
        return $result;
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
}

function xp_for_update(): string
{
    return xp_is_sqlite() ? '' : ' FOR UPDATE';
}

function xp_log_event(string $type, ?string $licenseId = null, ?string $deviceId = null, string $detail = '', string $ip = ''): void
{
    xp_exec(
        'INSERT INTO events (license_id, device_id, type, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [$licenseId, $deviceId, $type, mb_substr($detail, 0, 500), $ip, time()]
    );
}

// ---------------------------------------------------------------- http helpers
function xp_json(int $status, array $data): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function xp_fail(int $status, string $error, string $message, array $extra = []): void
{
    xp_json($status, array_merge(['ok' => false, 'error' => $error, 'message' => $message], $extra));
}

/** @return array<string,mixed>|null */
function xp_body(): ?array
{
    $raw = file_get_contents('php://input', false, null, 0, 16384);
    if ($raw === false || $raw === '') {
        return null;
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : null;
}

function xp_ip(): string
{
    $header = xp_config()['ip_header'] ?? 'REMOTE_ADDR';
    $value = $_SERVER[$header] ?? ($_SERVER['REMOTE_ADDR'] ?? '');
    if (strpos($value, ',') !== false) {
        $value = trim(explode(',', $value)[0]);
    }
    return filter_var($value, FILTER_VALIDATE_IP) ? $value : '';
}

function xp_clip($value, int $max): string
{
    return is_string($value) ? mb_substr(trim($value), 0, $max) : '';
}

function xp_is_https(): bool
{
    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
}

// ---------------------------------------------------------------- crypto
function xp_b64u_enc(string $bytes): string
{
    return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
}

function xp_b64u_dec(string $s): string
{
    $out = base64_decode(strtr($s, '-_', '+/') . str_repeat('=', (4 - strlen($s) % 4) % 4), true);
    return $out === false ? '' : $out;
}

function xp_sha256(string $s): string
{
    return hash('sha256', $s);
}

function xp_equals(string $a, string $b): bool
{
    return hash_equals(xp_sha256($a), xp_sha256($b));
}

function xp_generate_key(): string
{
    $bytes = random_bytes(20);
    $chars = '';
    for ($i = 0; $i < 20; $i++) {
        $chars .= XP_ALPHABET[ord($bytes[$i]) & 31];
    }
    return XP_KEY_PREFIX . '-' . implode('-', str_split($chars, 5));
}

/** Canonical `XPBM-XXXXX-XXXXX-XXXXX-XXXXX` or null when malformed. */
function xp_normalize_key($input): ?string
{
    if (!is_string($input) || strlen($input) > 64) {
        return null;
    }
    $s = strtoupper($input);
    $s = preg_replace('/[^0-9A-Z]/', '', $s);
    $s = str_replace(['I', 'L', 'O'], ['1', '1', '0'], $s);
    if (strpos($s, XP_KEY_PREFIX) !== 0 || strlen($s) !== strlen(XP_KEY_PREFIX) + 20) {
        return null;
    }
    $body = substr($s, strlen(XP_KEY_PREFIX));
    if (strspn($body, XP_ALPHABET) !== 20) {
        return null;
    }
    return XP_KEY_PREFIX . '-' . implode('-', str_split($body, 5));
}

/** Converts an ASN.1 DER ECDSA signature to the fixed 64-byte r||s form that .NET and WebCrypto expect. */
function xp_der_to_raw(string $der): string
{
    $pos = 0;
    if (ord($der[$pos++]) !== 0x30) {
        throw new RuntimeException('Firma DER inválida');
    }
    $len = ord($der[$pos++]);
    if ($len & 0x80) {
        $pos += $len & 0x7f;
    }
    $parts = [];
    for ($i = 0; $i < 2; $i++) {
        if (ord($der[$pos++]) !== 0x02) {
            throw new RuntimeException('Firma DER inválida');
        }
        $l = ord($der[$pos++]);
        $int = ltrim(substr($der, $pos, $l), "\x00");
        $pos += $l;
        $parts[] = str_pad($int, 32, "\x00", STR_PAD_LEFT);
    }
    return $parts[0] . $parts[1];
}

function xp_sign_token(array $payload): string
{
    $body = xp_b64u_enc(json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    $key = openssl_pkey_get_private(xp_config()['signing_key_pem']);
    if ($key === false || !openssl_sign($body, $der, $key, OPENSSL_ALGO_SHA256)) {
        throw new RuntimeException('No se pudo firmar el token.');
    }
    return $body . '.' . xp_b64u_enc(xp_der_to_raw($der));
}

// ---------------------------------------------------------------- admin sessions
function xp_session_create(int $ttl): string
{
    $body = xp_b64u_enc(json_encode(['exp' => time() + $ttl]));
    return $body . '.' . xp_b64u_enc(hash_hmac('sha256', $body, xp_config()['session_secret'], true));
}

function xp_session_valid(?string $cookie): bool
{
    if (!$cookie || substr_count($cookie, '.') !== 1) {
        return false;
    }
    [$body, $sig] = explode('.', $cookie);
    $expected = hash_hmac('sha256', $body, xp_config()['session_secret'], true);
    if (!hash_equals($expected, xp_b64u_dec($sig))) {
        return false;
    }
    $data = json_decode(xp_b64u_dec($body), true);
    return is_array($data) && isset($data['exp']) && $data['exp'] > time();
}

// ---------------------------------------------------------------- shapes
function xp_license_public(array $l, int $expiringDays = 30): array
{
    $t = time();
    $expires = (int) $l['expires_at'];
    $state = $l['status'] !== 'active' ? $l['status']
        : ($expires <= $t ? 'expired' : ($expires - $t <= $expiringDays * XP_DAY ? 'expiring' : 'active'));
    $out = [
        'id' => $l['id'],
        'keyHint' => $l['key_hint'],
        'customerName' => $l['customer_name'],
        'customerEmail' => $l['customer_email'],
        'plan' => $l['plan'],
        'maxDevices' => (int) $l['max_devices'],
        'isTrial' => !empty($l['is_trial']),
        'status' => $l['status'],
        'state' => $state,
        'expiresAt' => $expires,
        'notes' => $l['notes'],
        'createdAt' => (int) $l['created_at'],
        'updatedAt' => (int) $l['updated_at'],
    ];
    if (array_key_exists('devices_active', $l)) {
        $out['devicesActive'] = (int) $l['devices_active'];
        $out['lastSeen'] = $l['last_seen'] === null ? null : (int) $l['last_seen'];
    }
    return $out;
}

function xp_uuid(): string
{
    $b = random_bytes(16);
    $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
    $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
    $h = bin2hex($b);
    return substr($h, 0, 8) . '-' . substr($h, 8, 4) . '-' . substr($h, 12, 4) . '-' . substr($h, 16, 4) . '-' . substr($h, 20);
}

require_once __DIR__ . '/license_api.php';
require_once __DIR__ . '/admin_api.php';
require_once __DIR__ . '/portal_api.php';

// ---------------------------------------------------------------- dispatch
function xp_dispatch(): void
{
    $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    try {
        if (preg_match('#/api/v1/([a-z]+)/?$#', $path, $m)) {
            xp_route_license($method, $m[1]);
        } elseif (preg_match('#/admin/api/(.*?)/?$#', $path, $m)) {
            xp_route_admin($method, $m[1]);
        } elseif (preg_match('#/portal/api/(.*?)/?$#', $path, $m)) {
            xp_route_portal($method, $m[1]);
        } elseif (rtrim($path, '/') === '' || $path === '/index.php') {
            header('Location: portal/');
            exit;
        }
        xp_json(404, ['ok' => false, 'error' => 'not_found']);
    } catch (Throwable $e) {
        error_log('[xportbim-license] ' . $e);
        xp_json(500, ['ok' => false, 'error' => 'server_error', 'message' => 'Error interno del servidor.']);
    }
}
