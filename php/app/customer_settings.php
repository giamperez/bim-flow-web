<?php
declare(strict_types=1);

/** El plan gratuito se asigna una sola vez y no sustituye una licencia existente. */
function xp_ensure_free_license(array $customer): void
{
    if (xp_verification_required() && empty($customer['email_verified_at'])) { return; }
    $created = xp_tx(function () use ($customer) {
        $fresh = xp_one('SELECT * FROM customers WHERE id = ?' . xp_for_update(), [$customer['id']]);
        if (!$fresh || !empty($fresh['free_started_at']) || xp_portal_license_row($customer)) { return; }
        if (xp_verification_required() && empty($fresh['email_verified_at'])) { return; }
        [$id] = xp_new_license(['customer_name' => $customer['name'], 'customer_email' => $customer['email'],
            'plan' => 'Gratuito', 'max_devices' => 1, 'expires_at' => 253402300799,
            'customer_id' => $customer['id'], 'store_key' => true, 'is_trial' => false, 'access_mode' => 'free']);
        xp_log_event('free_plan_started', $id, null, '150 archivos al mes · PDF y DWG');
        xp_exec('UPDATE customers SET free_started_at = ? WHERE id = ?', [time(), $customer['id']]);
        return true;
    });
    if ($created) {
        $base = xp_base_url();
        xp_send_mail($customer['email'], 'Tu plan gratuito de Xport está activo', xp_mail_template('Tu espacio está listo',
            '<p>Xport Gratuito incluye una computadora y 150 archivos al mes en PDF y DWG. El cupo se renueva el primer día de cada mes en Perú.</p><p>Entra a tu cuenta para copiar tu clave e instalar Xport en Revit.</p>',
            $base !== '' ? $base . '/portal/#licencia' : null, 'Ver mi licencia'));
    }
}

function xp_portal_profile(array $customer): void
{
    $b = xp_body() ?? [];
    $name = xp_clip($b['name'] ?? $customer['name'], 120);
    $email = strtolower(xp_clip($b['email'] ?? $customer['email'], 160));
    $company = xp_clip($b['company'] ?? $customer['company'] ?? '', 120);
    $phone = xp_clip($b['phone'] ?? $customer['phone'] ?? '', 24);
    if ($name === '' || !filter_var($email, FILTER_VALIDATE_EMAIL) || xp_is_disposable_email($email)) {
        xp_json(400, ['ok' => false, 'error' => 'Revisa tu nombre y correo electrónico.']);
    }
    if ($phone !== '' && !preg_match('/^[+0-9 ()-]{6,24}$/', $phone)) {
        xp_json(400, ['ok' => false, 'error' => 'Ingresa un teléfono válido.']);
    }
    $emailChanged = $email !== $customer['email'];
    if ($emailChanged) {
        xp_check_current_password($customer, $b['currentPassword'] ?? '');
        if (xp_one('SELECT id FROM customers WHERE (email = ? OR email_norm = ?) AND id <> ?', [$email, xp_normalize_email($email), $customer['id']])) {
            xp_json(409, ['ok' => false, 'error' => 'Ese correo ya tiene una cuenta.']);
        }
    }
    $billing = json_decode($customer['billing_json'] ?? '{}', true) ?: [];
    if (isset($b['billing'])) {
        if (!is_array($b['billing'])) { xp_json(400, ['ok' => false, 'error' => 'Datos de facturación inválidos.']); }
        $billing = [];
        foreach (['name' => 160, 'documentType' => 10, 'documentNumber' => 20, 'address' => 200, 'city' => 80, 'country' => 2] as $key => $length) {
            $billing[$key] = xp_clip($b['billing'][$key] ?? '', $length);
        }
        if (!in_array($billing['documentType'], ['', 'DNI', 'RUC', 'CE'], true)
            || ($billing['country'] !== '' && !preg_match('/^[A-Z]{2}$/', $billing['country']))
            || ($billing['documentType'] === 'DNI' && !preg_match('/^\d{8}$/', $billing['documentNumber']))
            || ($billing['documentType'] === 'RUC' && !preg_match('/^\d{11}$/', $billing['documentNumber']))) {
            xp_json(400, ['ok' => false, 'error' => 'Revisa el tipo y número de documento y el país.']);
        }
    }
    xp_tx(function () use ($customer, $name, $email, $company, $phone, $billing, $emailChanged) {
        xp_exec('UPDATE customers SET name = ?, email = ?, email_norm = ?, company = ?, phone = ?, billing_json = ? WHERE id = ?',
            [$name, $email, xp_normalize_email($email), $company, $phone, json_encode($billing, JSON_UNESCAPED_UNICODE), $customer['id']]);
        xp_exec('UPDATE licenses SET customer_name = ?, customer_email = ?, updated_at = ? WHERE customer_id = ?', [$name, $email, time(), $customer['id']]);
        if ($emailChanged) {
            xp_exec('UPDATE customers SET session_version = session_version + 1, email_verified_at = ? WHERE id = ?', [xp_verification_required() ? null : time(), $customer['id']]);
            xp_exec('UPDATE email_tokens SET used_at = ? WHERE customer_id = ? AND used_at IS NULL', [time(), $customer['id']]);
        }
    });
    $updated = xp_one('SELECT * FROM customers WHERE id = ?', [$customer['id']]);
    if ($emailChanged) {
        xp_set_user_cookie($customer['id'], (int) $updated['session_version']);
        if (xp_verification_required()) { xp_send_verification($updated); }
    }
    xp_log_event('profile_updated', null, null, $customer['id'], xp_ip());
    xp_json(200, ['ok' => true, 'customer' => xp_customer_public($updated), 'verificationRequired' => xp_verification_required()]);
}

function xp_check_current_password(array $customer, $password): void
{
    if (xp_count_events('password_check_failed', 'detail = ?', [$customer['id']], 900) >= 8) {
        xp_json(429, ['ok' => false, 'error' => 'Demasiados intentos. Espera 15 minutos.']);
    }
    if (!is_string($password) || !password_verify($password, $customer['password_hash'])) {
        xp_log_event('password_check_failed', null, null, $customer['id'], xp_ip());
        xp_json(400, ['ok' => false, 'error' => 'La contraseña actual no es correcta.']);
    }
}

function xp_portal_password(array $customer): void
{
    $b = xp_body() ?? [];
    xp_check_current_password($customer, $b['currentPassword'] ?? '');
    $password = $b['password'] ?? '';
    if (!is_string($password) || strlen($password) < 8 || strlen($password) > 200) {
        xp_json(400, ['ok' => false, 'error' => 'Usa una contraseña de entre 8 y 200 caracteres.']);
    }
    xp_tx(function () use ($customer, $password) {
        xp_exec('UPDATE customers SET password_hash = ?, session_version = session_version + 1 WHERE id = ?', [password_hash($password, PASSWORD_DEFAULT), $customer['id']]);
        xp_exec('UPDATE email_tokens SET used_at = ? WHERE customer_id = ? AND used_at IS NULL AND type = ?', [time(), $customer['id'], 'reset']);
    });
    $updated = xp_one('SELECT * FROM customers WHERE id = ?', [$customer['id']]);
    xp_set_user_cookie($customer['id'], (int) $updated['session_version']);
    xp_log_event('password_changed', null, null, $customer['id'], xp_ip());
    xp_json(200, ['ok' => true]);
}
