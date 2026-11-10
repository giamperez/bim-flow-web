<?php
// API del panel de administración: /admin/api/*
declare(strict_types=1);

const XP_COOKIE = 'bf_admin';
const XP_SESSION_TTL = 12 * 3600;

function xp_route_admin(string $method, string $route): void
{
    if ($route === 'login' && $method === 'POST') {
        xp_admin_login();
    }
    if ($route === 'logout' && $method === 'POST') {
        setcookie(XP_COOKIE, '', ['expires' => 1, 'path' => '/', 'httponly' => true, 'samesite' => 'Strict']);
        xp_json(200, ['ok' => true]);
    }

    if (!xp_session_valid($_COOKIE[XP_COOKIE] ?? null)) {
        xp_json(401, ['ok' => false, 'error' => 'unauthorized']);
    }
    // CSRF: mutating calls must carry a header that cross-site forms cannot set.
    if ($method !== 'GET' && ($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'bimflow') {
        xp_json(403, ['ok' => false, 'error' => 'csrf']);
    }

    $parts = $route === '' ? [] : explode('/', $route);
    $n = count($parts);

    if ($route === 'me' && $method === 'GET') {
        xp_json(200, ['ok' => true]);
    }
    if ($route === 'stats' && $method === 'GET') {
        xp_admin_stats();
    }
    if ($route === 'events' && $method === 'GET') {
        xp_admin_events();
    }
    if ($parts && $parts[0] === 'licenses') {
        if ($n === 1 && $method === 'GET') {
            xp_admin_list();
        }
        if ($n === 1 && $method === 'POST') {
            xp_admin_create();
        }
        if ($n >= 2) {
            $id = $parts[1];
            if ($n === 2 && $method === 'GET') {
                xp_admin_detail($id);
            }
            if ($n === 2 && ($method === 'PATCH' || $method === 'PUT')) {
                xp_admin_update($id);
            }
            if ($n === 2 && $method === 'DELETE') {
                xp_admin_delete($id);
            }
            if ($n === 3 && $parts[2] === 'extend' && $method === 'POST') {
                xp_admin_extend($id);
            }
            if ($n === 3 && $parts[2] === 'regenerate-key' && $method === 'POST') {
                xp_admin_regenerate($id);
            }
            if ($n === 5 && $parts[2] === 'devices' && $parts[4] === 'release' && $method === 'POST') {
                xp_admin_release_device($id, $parts[3]);
            }
        }
    }
    xp_json(404, ['ok' => false, 'error' => 'not_found']);
}

function xp_admin_login(): void
{
    $ip = xp_ip();
    $since = time() - 900;
    $perIp = $ip === '' ? 0 : (int) xp_one("SELECT COUNT(*) AS n FROM events WHERE type = 'admin_login_failed' AND ip = ? AND created_at > ?", [$ip, $since])['n'];
    // The client address may be forged behind some proxies, so a global ceiling backs up the per-address one.
    $global = (int) xp_one("SELECT COUNT(*) AS n FROM events WHERE type = 'admin_login_failed' AND created_at > ?", [$since])['n'];
    if ($perIp >= 5 || $global >= 30) {
        xp_json(429, ['ok' => false, 'error' => 'Demasiados intentos. Espere 15 minutos.']);
    }
    $body = xp_body() ?? [];
    $password = is_string($body['password'] ?? null) ? $body['password'] : '';
    if ($password === '' || !password_verify($password, xp_config()['admin_password_hash'])) {
        xp_log_event('admin_login_failed', null, null, '', $ip);
        xp_json(401, ['ok' => false, 'error' => 'Contraseña incorrecta.']);
    }
    setcookie(XP_COOKIE, xp_session_create(XP_SESSION_TTL), [
        'expires' => time() + XP_SESSION_TTL,
        'path' => '/',
        'secure' => xp_is_https(),
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
    xp_log_event('admin_login', null, null, '', $ip);
    xp_json(200, ['ok' => true]);
}

function xp_admin_stats(): void
{
    $t = time();
    $lic = xp_one(
        "SELECT
           SUM(CASE WHEN status = 'active' AND expires_at > ? THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN status = 'active' AND expires_at > ? AND expires_at <= ? THEN 1 ELSE 0 END) AS expiring,
           SUM(CASE WHEN status = 'active' AND expires_at <= ? THEN 1 ELSE 0 END) AS expired,
           SUM(CASE WHEN status != 'active' THEN 1 ELSE 0 END) AS blocked,
           COUNT(*) AS total
         FROM licenses",
        [$t, $t, $t + 30 * XP_DAY, $t]
    );
    $dev = xp_one("SELECT COUNT(*) AS n FROM devices WHERE status = 'active'");
    $ev = xp_one("SELECT COUNT(*) AS n FROM events WHERE created_at > ? AND type IN ('bad_key','device_limit')", [$t - 7 * XP_DAY]);
    $next = xp_all(
        "SELECT id, key_hint, customer_name, expires_at FROM licenses WHERE status = 'active' AND expires_at > ? ORDER BY expires_at ASC LIMIT 5",
        [$t]
    );
    xp_json(200, [
        'ok' => true,
        'licenses' => [
            'active' => (int) $lic['active'],
            'expiring' => (int) $lic['expiring'],
            'expired' => (int) $lic['expired'],
            'blocked' => (int) $lic['blocked'],
            'total' => (int) $lic['total'],
        ],
        'devicesActive' => (int) $dev['n'],
        'suspiciousLast7d' => (int) $ev['n'],
        'nextToExpire' => array_map(function ($r) {
            return ['id' => $r['id'], 'keyHint' => $r['key_hint'], 'customerName' => $r['customer_name'], 'expiresAt' => (int) $r['expires_at']];
        }, $next),
    ]);
}

function xp_admin_list(): void
{
    $q = xp_clip($_GET['q'] ?? '', 80);
    $state = (string) ($_GET['state'] ?? '');
    $page = max(0, (int) ($_GET['page'] ?? 0));
    $size = 25;
    $t = time();
    $where = [];
    $binds = [];
    if ($q !== '') {
        $where[] = '(l.customer_name LIKE ? OR l.customer_email LIKE ? OR l.key_hint LIKE ?)';
        $like = '%' . addcslashes($q, '\\%_') . '%';
        array_push($binds, $like, $like, $like);
    }
    if ($state === 'active') {
        $where[] = "l.status = 'active' AND l.expires_at > ?";
        $binds[] = $t;
    } elseif ($state === 'expiring') {
        $where[] = "l.status = 'active' AND l.expires_at > ? AND l.expires_at <= ?";
        array_push($binds, $t, $t + 30 * XP_DAY);
    } elseif ($state === 'expired') {
        $where[] = "l.status = 'active' AND l.expires_at <= ?";
        $binds[] = $t;
    } elseif ($state === 'suspended' || $state === 'revoked') {
        $where[] = 'l.status = ?';
        $binds[] = $state;
    }
    $clause = $where ? 'WHERE ' . implode(' AND ', $where) : '';
    $limit = $size + 1;
    $offset = $page * $size;
    $rows = xp_all(
        "SELECT l.*,
           (SELECT COUNT(*) FROM devices d WHERE d.license_id = l.id AND d.status = 'active') AS devices_active,
           (SELECT MAX(last_seen) FROM devices d WHERE d.license_id = l.id) AS last_seen
         FROM licenses l $clause ORDER BY l.created_at DESC, l.id DESC LIMIT $limit OFFSET $offset",
        $binds
    );
    xp_json(200, [
        'ok' => true,
        'page' => $page,
        'hasMore' => count($rows) > $size,
        'licenses' => array_map('xp_license_public', array_slice($rows, 0, $size)),
    ]);
}

function xp_expiry_from(array $body, int $base): ?int
{
    if (isset($body['expiresAt']) && is_numeric($body['expiresAt']) && $body['expiresAt'] > 0) {
        return (int) $body['expiresAt'];
    }
    $days = isset($body['days']) && is_numeric($body['days']) ? (int) floor((float) $body['days']) : 0;
    return ($days > 0 && $days <= 3650) ? $base + $days * XP_DAY : null;
}

function xp_admin_create(): void
{
    $body = xp_body() ?? [];
    $name = xp_clip($body['customerName'] ?? '', 120);
    if ($name === '') {
        xp_json(400, ['ok' => false, 'error' => 'El nombre del cliente es obligatorio.']);
    }
    $maxDevices = (int) floor((float) ($body['maxDevices'] ?? 2));
    if ($maxDevices < 1 || $maxDevices > 100) {
        xp_json(400, ['ok' => false, 'error' => 'Equipos permitidos: 1 a 100.']);
    }
    $t = time();
    $expires = xp_expiry_from($body, $t);
    if (!$expires || $expires <= $t) {
        xp_json(400, ['ok' => false, 'error' => 'Indique un vencimiento futuro.']);
    }
    $key = xp_generate_key();
    $id = xp_uuid();
    xp_exec(
        "INSERT INTO licenses (id, key_hash, key_hint, customer_name, customer_email, plan, max_devices, status, expires_at, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)",
        [$id, xp_sha256($key), substr($key, -5), $name, xp_clip($body['customerEmail'] ?? '', 160), xp_clip($body['plan'] ?? '', 40) ?: 'standard', $maxDevices, $expires, xp_clip($body['notes'] ?? '', 1000), $t, $t]
    );
    xp_log_event('admin_created', $id, null, $name);
    // The key is shown once; only its hash is stored.
    xp_json(201, ['ok' => true, 'key' => $key, 'license' => xp_license_public(xp_one('SELECT * FROM licenses WHERE id = ?', [$id]))]);
}

function xp_admin_detail(string $id): void
{
    $lic = xp_one('SELECT * FROM licenses WHERE id = ?', [$id]);
    if (!$lic) {
        xp_json(404, ['ok' => false, 'error' => 'No encontrada.']);
    }
    $devices = xp_all('SELECT * FROM devices WHERE license_id = ? ORDER BY status ASC, last_seen DESC', [$id]);
    $events = xp_all('SELECT id, device_id, type, detail, ip, created_at FROM events WHERE license_id = ? ORDER BY id DESC LIMIT 50', [$id]);
    xp_json(200, [
        'ok' => true,
        'license' => xp_license_public($lic),
        'devices' => array_map(function ($d) {
            return [
                'id' => $d['id'],
                'name' => $d['device_name'],
                'revitVersion' => $d['revit_version'],
                'appVersion' => $d['app_version'],
                'status' => $d['status'],
                'firstSeen' => (int) $d['first_seen'],
                'lastSeen' => (int) $d['last_seen'],
                'releasedAt' => $d['released_at'] === null ? null : (int) $d['released_at'],
            ];
        }, $devices),
        'events' => array_map(function ($e) {
            $e['id'] = (int) $e['id'];
            $e['created_at'] = (int) $e['created_at'];
            return $e;
        }, $events),
    ]);
}

function xp_admin_update(string $id): void
{
    $body = xp_body() ?? [];
    $lic = xp_one('SELECT * FROM licenses WHERE id = ?', [$id]);
    if (!$lic) {
        xp_json(404, ['ok' => false, 'error' => 'No encontrada.']);
    }
    $next = [
        'customer_name' => array_key_exists('customerName', $body) ? xp_clip($body['customerName'], 120) : $lic['customer_name'],
        'customer_email' => array_key_exists('customerEmail', $body) ? xp_clip($body['customerEmail'], 160) : $lic['customer_email'],
        'plan' => array_key_exists('plan', $body) ? (xp_clip($body['plan'], 40) ?: $lic['plan']) : $lic['plan'],
        'notes' => array_key_exists('notes', $body) ? xp_clip($body['notes'], 1000) : $lic['notes'],
        'max_devices' => array_key_exists('maxDevices', $body) ? (int) floor((float) $body['maxDevices']) : (int) $lic['max_devices'],
        'status' => array_key_exists('status', $body) ? (string) $body['status'] : $lic['status'],
        'expires_at' => array_key_exists('expiresAt', $body) ? (int) floor((float) $body['expiresAt']) : (int) $lic['expires_at'],
    ];
    if ($next['customer_name'] === '') {
        xp_json(400, ['ok' => false, 'error' => 'El nombre es obligatorio.']);
    }
    if ($next['max_devices'] < 1 || $next['max_devices'] > 100) {
        xp_json(400, ['ok' => false, 'error' => 'Equipos permitidos: 1 a 100.']);
    }
    if (!in_array($next['status'], ['active', 'suspended', 'revoked'], true)) {
        xp_json(400, ['ok' => false, 'error' => 'Estado inválido.']);
    }
    if ($next['expires_at'] <= 0) {
        xp_json(400, ['ok' => false, 'error' => 'Vencimiento inválido.']);
    }
    xp_exec(
        'UPDATE licenses SET customer_name=?, customer_email=?, plan=?, notes=?, max_devices=?, status=?, expires_at=?, updated_at=? WHERE id=?',
        [$next['customer_name'], $next['customer_email'], $next['plan'], $next['notes'], $next['max_devices'], $next['status'], $next['expires_at'], time(), $id]
    );
    $changes = [];
    if ($next['status'] !== $lic['status']) {
        $changes[] = "estado {$lic['status']}→{$next['status']}";
    }
    if ($next['expires_at'] !== (int) $lic['expires_at']) {
        $changes[] = 'vence ' . gmdate('Y-m-d', $next['expires_at']);
    }
    if ($next['max_devices'] !== (int) $lic['max_devices']) {
        $changes[] = "equipos {$lic['max_devices']}→{$next['max_devices']}";
    }
    xp_log_event('admin_updated', $id, null, $changes ? implode(', ', $changes) : 'datos');
    xp_json(200, ['ok' => true, 'license' => xp_license_public(xp_one('SELECT * FROM licenses WHERE id = ?', [$id]))]);
}

/** Extends from the later of "now" and the current expiry, so early renewals don't lose time. */
function xp_admin_extend(string $id): void
{
    $body = xp_body() ?? [];
    $days = (int) floor((float) ($body['days'] ?? 0));
    if ($days < 1 || $days > 3650) {
        xp_json(400, ['ok' => false, 'error' => 'Días: 1 a 3650.']);
    }
    $lic = xp_one('SELECT * FROM licenses WHERE id = ?', [$id]);
    if (!$lic) {
        xp_json(404, ['ok' => false, 'error' => 'No encontrada.']);
    }
    $expires = max((int) $lic['expires_at'], time()) + $days * XP_DAY;
    xp_exec('UPDATE licenses SET expires_at = ?, updated_at = ? WHERE id = ?', [$expires, time(), $id]);
    xp_log_event('admin_extended', $id, null, "+$days días");
    xp_json(200, ['ok' => true, 'expiresAt' => $expires]);
}

function xp_admin_regenerate(string $id): void
{
    if (!xp_one('SELECT id FROM licenses WHERE id = ?', [$id])) {
        xp_json(404, ['ok' => false, 'error' => 'No encontrada.']);
    }
    $key = xp_generate_key();
    xp_exec('UPDATE licenses SET key_hash = ?, key_hint = ?, updated_at = ? WHERE id = ?', [xp_sha256($key), substr($key, -5), time(), $id]);
    xp_log_event('admin_key_regenerated', $id);
    xp_json(200, ['ok' => true, 'key' => $key]);
}

function xp_admin_delete(string $id): void
{
    $lic = xp_one('SELECT customer_name FROM licenses WHERE id = ?', [$id]);
    if (!$lic) {
        xp_json(404, ['ok' => false, 'error' => 'No encontrada.']);
    }
    xp_tx(function () use ($id) {
        xp_exec('DELETE FROM devices WHERE license_id = ?', [$id]);
        xp_exec('DELETE FROM licenses WHERE id = ?', [$id]);
    });
    xp_log_event('admin_deleted', null, null, $lic['customer_name']);
    xp_json(200, ['ok' => true]);
}

function xp_admin_release_device(string $licenseId, string $deviceId): void
{
    $dev = xp_one("SELECT device_name FROM devices WHERE id = ? AND license_id = ? AND status = 'active'", [$deviceId, $licenseId]);
    if (!$dev) {
        xp_json(404, ['ok' => false, 'error' => 'Equipo no encontrado o ya liberado.']);
    }
    xp_exec("UPDATE devices SET status = 'released', released_at = ? WHERE id = ?", [time(), $deviceId]);
    xp_log_event('admin_released_device', $licenseId, $deviceId, $dev['device_name']);
    xp_json(200, ['ok' => true]);
}

function xp_admin_events(): void
{
    $type = xp_clip($_GET['type'] ?? '', 40);
    $page = max(0, (int) ($_GET['page'] ?? 0));
    $size = 50;
    $limit = $size + 1;
    $offset = $page * $size;
    $rows = xp_all(
        "SELECT e.id, e.type, e.detail, e.ip, e.created_at, e.license_id, l.customer_name, l.key_hint
         FROM events e LEFT JOIN licenses l ON l.id = e.license_id "
        . ($type !== '' ? 'WHERE e.type = ? ' : '') .
        "ORDER BY e.id DESC LIMIT $limit OFFSET $offset",
        $type !== '' ? [$type] : []
    );
    $events = array_map(function ($e) {
        $e['id'] = (int) $e['id'];
        $e['created_at'] = (int) $e['created_at'];
        return $e;
    }, array_slice($rows, 0, $size));
    xp_json(200, ['ok' => true, 'page' => $page, 'hasMore' => count($rows) > $size, 'events' => $events]);
}
