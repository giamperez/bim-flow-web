<?php
declare(strict_types=1);

/** Explicit projection: never return password hashes, sessions or payment references. */
function xp_admin_customer_public(array $r): array
{
    return ['id' => $r['id'], 'name' => $r['name'], 'email' => $r['email'],
        'company' => $r['company'] ?? '', 'phone' => $r['phone'] ?? '',
        'verified' => !empty($r['email_verified_at']), 'createdAt' => (int) $r['created_at'],
        'licensesCount' => (int) ($r['licenses_count'] ?? 0)];
}

function xp_admin_customers(): void
{
    $q = xp_clip($_GET['q'] ?? '', 80);
    $page = min(100000, max(0, (int) ($_GET['page'] ?? 0)));
    $where = $q === '' ? '' : 'WHERE (c.name LIKE ? OR c.email LIKE ? OR c.company LIKE ?)';
    $params = $q === '' ? [] : array_fill(0, 3, '%' . $q . '%');
    $offset = $page * 25;
    $rows = xp_all("SELECT c.id, c.name, c.email, c.company, c.phone, c.email_verified_at, c.created_at,
        (SELECT COUNT(*) FROM licenses l WHERE l.customer_id = c.id) AS licenses_count
        FROM customers c $where ORDER BY c.created_at DESC, c.id DESC LIMIT 26 OFFSET $offset", $params);
    xp_json(200, ['ok' => true, 'customers' => array_map('xp_admin_customer_public', array_slice($rows, 0, 25)),
        'hasMore' => count($rows) > 25, 'page' => $page]);
}

function xp_admin_customer_detail(string $id): void
{
    $r = xp_one('SELECT * FROM customers WHERE id = ?', [$id]);
    if (!$r) { xp_json(404, ['ok' => false, 'error' => 'Usuario no encontrado.']); }
    $licenses = xp_all('SELECT * FROM licenses WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50', [$id]);
    $r['licenses_count'] = (int) xp_one('SELECT COUNT(*) AS n FROM licenses WHERE customer_id = ?', [$id])['n'];
    $orders = xp_one("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid FROM orders WHERE customer_id = ?", [$id]);
    xp_json(200, ['ok' => true, 'customer' => xp_admin_customer_public($r),
        'licenses' => array_map('xp_license_public', $licenses),
        'ordersCount' => (int) $orders['total'], 'paidOrders' => (int) $orders['paid']]);
}

function xp_admin_customer_update(string $id): void
{
    $b = xp_body() ?? [];
    $result = xp_tx(function () use ($id, $b) {
        $r = xp_one('SELECT * FROM customers WHERE id = ?' . xp_for_update(), [$id]);
        if (!$r) { return [404, 'Usuario no encontrado.']; }
        $name = xp_clip($b['name'] ?? $r['name'], 120);
        $email = strtolower(xp_clip($b['email'] ?? $r['email'], 160));
        $company = xp_clip($b['company'] ?? $r['company'] ?? '', 120);
        $phone = xp_clip($b['phone'] ?? $r['phone'] ?? '', 24);
        if ($name === '' || !filter_var($email, FILTER_VALIDATE_EMAIL) || xp_is_disposable_email($email)
            || ($phone !== '' && !preg_match('/^[+0-9 ()-]{6,24}$/', $phone))) {
            return [400, 'Revisa el nombre, correo y teléfono.'];
        }
        if (xp_one('SELECT id FROM customers WHERE (email = ? OR email_norm = ?) AND id <> ?', [$email, xp_normalize_email($email), $id])) {
            return [409, 'Ese correo ya pertenece a otro usuario.'];
        }
        xp_exec('UPDATE customers SET name = ?, email = ?, email_norm = ?, company = ?, phone = ? WHERE id = ?',
            [$name, $email, xp_normalize_email($email), $company, $phone, $id]);
        xp_exec('UPDATE licenses SET customer_name = ?, customer_email = ?, updated_at = ? WHERE customer_id = ?', [$name, $email, time(), $id]);
        if ($email !== $r['email']) {
            xp_exec('UPDATE customers SET email_verified_at = NULL, session_version = session_version + 1 WHERE id = ?', [$id]);
            xp_exec('UPDATE email_tokens SET used_at = ? WHERE customer_id = ? AND used_at IS NULL', [time(), $id]);
        }
        xp_log_event('admin_customer_updated', null, null, $id);
        return [200, ''];
    });
    if ($result[0] !== 200) { xp_json($result[0], ['ok' => false, 'error' => $result[1]]); }
    xp_json(200, ['ok' => true]);
}

function xp_admin_customer_revoke_sessions(string $id): void
{
    if (!xp_one('SELECT id FROM customers WHERE id = ?', [$id])) { xp_json(404, ['ok' => false, 'error' => 'Usuario no encontrado.']); }
    xp_exec('UPDATE customers SET session_version = session_version + 1 WHERE id = ?', [$id]);
    xp_log_event('admin_customer_sessions_revoked', null, null, $id);
    xp_json(200, ['ok' => true]);
}
