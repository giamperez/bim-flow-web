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
    $providers = array_column(xp_all('SELECT provider FROM oauth_identities WHERE customer_id = ?', [$id]), 'provider');
    $sub = xp_sub_public($r);
    xp_json(200, ['ok' => true, 'customer' => xp_admin_customer_public($r) + ['providers' => $providers], 'subscription' => $sub,
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
        $password = is_string($b['password'] ?? null) ? $b['password'] : '';
        if ($password !== '' && (strlen($password) < 8 || strlen($password) > 200)) { return [400, 'La contraseña debe tener entre 8 y 200 caracteres.']; }
        xp_exec('UPDATE customers SET name = ?, email = ?, email_norm = ?, company = ?, phone = ? WHERE id = ?',
            [$name, $email, xp_normalize_email($email), $company, $phone, $id]);
        if ($password !== '') {
            xp_exec('UPDATE customers SET password_hash = ?, password_set = 1, session_version = session_version + 1 WHERE id = ?', [password_hash($password, PASSWORD_DEFAULT), $id]);
            xp_log_event('admin_customer_password_set', null, null, $id);
        }
        xp_exec('UPDATE licenses SET customer_name = ?, customer_email = ?, updated_at = ? WHERE customer_id = ?', [$name, $email, time(), $id]);
        if ($email !== $r['email']) {
            xp_exec('UPDATE customers SET email_verified_at = NULL, session_version = session_version + 1 WHERE id = ?', [$id]);
            xp_exec('UPDATE email_tokens SET used_at = ? WHERE customer_id = ? AND used_at IS NULL', [time(), $id]);
        }
        // The administrator may confirm or unconfirm the address explicitly (a changed address always starts unverified).
        if (array_key_exists('verified', $b)) {
            $verified = filter_var($b['verified'], FILTER_VALIDATE_BOOLEAN);
            if ($verified) { xp_exec('UPDATE customers SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?', [time(), $id]); }
            elseif ($email === $r['email']) { xp_exec('UPDATE customers SET email_verified_at = NULL WHERE id = ?', [$id]); }
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

/** Sends the link where the customer chooses a password (first access or administrator-initiated reset). */
function xp_admin_send_password_link(array $c, int $ttl, bool $invite): bool
{
    $base = xp_base_url();
    if (!xp_mail_enabled() || $base === '') { return false; }
    $token = xp_token_create($c['id'], 'reset', $ttl);
    $hours = intdiv($ttl, 3600);
    $lead = $invite
        ? '<p>Hola ' . htmlspecialchars($c['name']) . ',</p><p>Creamos una cuenta para ti en Xport. Elige tu contraseña para entrar al portal, activar tu licencia y descargar el instalador.</p><p>El enlace vale ' . $hours . ' horas y solo se puede usar una vez.</p>'
        : '<p>Hola ' . htmlspecialchars($c['name']) . ',</p><p>El administrador te envía este enlace para que crees una contraseña nueva. Vale ' . $hours . ' horas y solo se puede usar una vez.</p>';
    return xp_send_mail($c['email'], $invite ? 'Tu cuenta de Xport está lista' : 'Crea una contraseña nueva en Xport',
        xp_mail_template($invite ? 'Tu cuenta está lista' : 'Crea una contraseña nueva', $lead, $base . '/portal/#reset=' . $token, 'Elegir mi contraseña'));
}

function xp_admin_customer_create(): void
{
    $b = xp_body() ?? [];
    $name = xp_clip($b['name'] ?? '', 120);
    $email = strtolower(xp_clip($b['email'] ?? '', 160));
    $company = xp_clip($b['company'] ?? '', 120);
    $phone = xp_clip($b['phone'] ?? '', 24);
    $password = is_string($b['password'] ?? null) ? $b['password'] : '';
    $verified = !array_key_exists('verified', $b) || filter_var($b['verified'], FILTER_VALIDATE_BOOLEAN);
    $invite = $password === '';
    if ($name === '' || !filter_var($email, FILTER_VALIDATE_EMAIL) || ($phone !== '' && !preg_match('/^[+0-9 ()-]{6,24}$/', $phone))) {
        xp_json(400, ['ok' => false, 'error' => 'Revisa el nombre, correo y teléfono.']);
    }
    if (!$invite && (strlen($password) < 8 || strlen($password) > 200)) {
        xp_json(400, ['ok' => false, 'error' => 'La contraseña debe tener entre 8 y 200 caracteres.']);
    }
    if ($invite && (!xp_mail_enabled() || xp_base_url() === '')) {
        xp_json(400, ['ok' => false, 'error' => 'El correo no está configurado: define una contraseña para esta cuenta.']);
    }
    $id = xp_uuid();
    $result = xp_tx(function () use ($id, $name, $email, $company, $phone, $password, $verified, $invite) {
        if (xp_one('SELECT id FROM customers WHERE email = ? OR email_norm = ?', [$email, xp_normalize_email($email)])) { return 409; }
        $hash = password_hash($invite ? bin2hex(random_bytes(32)) : $password, PASSWORD_DEFAULT);
        xp_exec('INSERT INTO customers (id, email, email_norm, name, password_hash, company, phone, created_at, email_verified_at, session_version, password_set) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)',
            [$id, $email, xp_normalize_email($email), $name, $hash, $company, $phone, time(), ($verified || $invite) ? time() : null, $invite ? 0 : 1]);
        return 200;
    });
    if ($result === 409) { xp_json(409, ['ok' => false, 'error' => 'Ya existe un usuario con ese correo.']); }
    xp_log_event('admin_customer_created', null, null, $id);
    $mailed = $invite ? xp_admin_send_password_link(xp_one('SELECT * FROM customers WHERE id = ?', [$id]), 2 * XP_DAY, true) : false;
    xp_json(200, ['ok' => true, 'id' => $id, 'invited' => $invite, 'mailSent' => $mailed]);
}

function xp_admin_customer_send_reset(string $id): void
{
    $c = xp_one('SELECT * FROM customers WHERE id = ?', [$id]);
    if (!$c) { xp_json(404, ['ok' => false, 'error' => 'Usuario no encontrado.']); }
    if (xp_count_events('admin_customer_reset_link', 'detail = ?', [$id], 3600) >= 5) {
        xp_json(429, ['ok' => false, 'error' => 'Ya enviaste varios enlaces a este usuario. Inténtalo en una hora.']);
    }
    if (!xp_admin_send_password_link($c, 6 * 3600, false)) {
        xp_json(502, ['ok' => false, 'error' => 'No se pudo enviar el correo. Revisa la configuración de correo.']);
    }
    xp_log_event('admin_customer_reset_link', null, null, $id);
    xp_json(200, ['ok' => true]);
}

/**
 * Deletes an account. Free-edition licences belong to the account and always go with it; paid licences are kept
 * (detached from the account, still valid for the key holder) unless the administrator explicitly deletes them too.
 * The trial's device fingerprints are kept on purpose so that deleting and re-registering cannot restart a trial.
 */
function xp_admin_customer_delete(string $id): void
{
    $b = xp_body() ?? [];
    $deleteLicenses = ($b['licenses'] ?? 'keep') === 'delete';
    $result = xp_tx(function () use ($id, $deleteLicenses) {
        $c = xp_one('SELECT id, email FROM customers WHERE id = ?' . xp_for_update(), [$id]);
        if (!$c) { return [404, 'Usuario no encontrado.', '']; }
        if (xp_one("SELECT id FROM orders WHERE customer_id = ? AND status = 'processing'", [$id])) {
            return [409, 'Tiene un pago en verificación. Apruébalo o cancélalo en Pedidos antes de eliminar la cuenta.', ''];
        }
        $where = $deleteLicenses ? 'customer_id = ?' : "customer_id = ? AND access_mode = 'free'";
        foreach (xp_all("SELECT id FROM licenses WHERE $where", [$id]) as $l) {
            xp_exec('DELETE FROM devices WHERE license_id = ?', [$l['id']]);
            xp_exec('DELETE FROM licenses WHERE id = ?', [$l['id']]);
        }
        xp_exec('UPDATE licenses SET customer_id = NULL, updated_at = ? WHERE customer_id = ?', [time(), $id]);
        xp_exec("UPDATE orders SET status = 'cancelled' WHERE customer_id = ? AND status = 'pending'", [$id]);
        foreach (['email_tokens', 'oauth_identities', 'payment_methods', 'payment_customers', 'subscriptions'] as $table) {
            xp_exec("DELETE FROM $table WHERE customer_id = ?", [$id]);
        }
        xp_exec('DELETE FROM customers WHERE id = ?', [$id]);
        return [200, '', $c['email']];
    });
    if ($result[0] !== 200) { xp_json($result[0], ['ok' => false, 'error' => $result[1]]); }
    xp_log_event('admin_customer_deleted', null, null, $result[2]);
    xp_json(200, ['ok' => true]);
}

/** Soporte: dejar de cobrar a un cliente (por ejemplo tras una disputa). El plan sigue hasta el final del período pagado. */
function xp_admin_customer_stop_auto(string $id): void
{
    $n = xp_exec('UPDATE subscriptions SET auto_renew = 0, pending_plan_id = NULL, next_attempt_at = NULL, updated_at = ? WHERE customer_id = ? AND auto_renew = 1', [time(), $id]);
    if ($n === 0) { xp_json(409, ['ok' => false, 'error' => 'Este usuario no tiene renovación automática activa.']); }
    xp_log_event('admin_auto_renew_off', null, null, $id);
    xp_json(200, ['ok' => true]);
}
