<?php
// Correo saliente: SMTP (cualquier proveedor) o "log" (solo desarrollo: escribe los correos en un archivo).
declare(strict_types=1);

/** @return array<string,mixed> */
function xp_mail_cfg(): array
{
    return xp_config()['mail'] ?? ['driver' => 'none'];
}

function xp_mail_enabled(): bool
{
    return (xp_mail_cfg()['driver'] ?? 'none') !== 'none';
}

/**
 * URL base para los enlaces de los correos. En producción debe venir de `public_url`: el encabezado Host lo controla
 * quien hace la petición y permitiría fabricar enlaces de recuperación hacia otro sitio. Solo con el driver "log"
 * (desarrollo) se deduce de la petición.
 */
function xp_base_url(): string
{
    $configured = xp_config()['public_url'] ?? '';
    if ($configured !== '') {
        return rtrim($configured, '/');
    }
    if ((xp_mail_cfg()['driver'] ?? '') === 'log' && !empty($_SERVER['HTTP_HOST']) && preg_match('/^[A-Za-z0-9.\-:\[\]]+$/', $_SERVER['HTTP_HOST'])) {
        return (xp_is_https() ? 'https://' : 'http://') . $_SERVER['HTTP_HOST'];
    }
    return '';
}

/** Plantilla sencilla con la identidad de marca. */
function xp_mail_template(string $title, string $bodyHtml, ?string $buttonUrl, ?string $buttonLabel): string
{
    $base = xp_base_url();
    $logo = $base !== '' ? '<img src="' . htmlspecialchars($base . '/brand/logo-header.png', ENT_QUOTES) . '" alt="BIM FLOW" height="38" style="display:block;border:0;height:38px;width:auto">' : '<b style="font-size:20px;color:#005bae">BIM FLOW</b>';
    $button = '';
    if ($buttonUrl && $buttonLabel) {
        $button = '<p style="margin:26px 0"><a href="' . htmlspecialchars($buttonUrl, ENT_QUOTES) . '" style="background:#005bae;color:#ffffff;text-decoration:none;font-weight:700;padding:13px 26px;border-radius:999px;display:inline-block">' . htmlspecialchars($buttonLabel) . '</a></p>'
            . '<p style="font-size:12px;color:#6b7c93;word-break:break-all">Si el botón no funciona, copia este enlace en tu navegador:<br>' . htmlspecialchars($buttonUrl) . '</p>';
    }
    return '<!doctype html><html><body style="margin:0;padding:24px;background:#eef6f9;font-family:Montserrat,Segoe UI,Arial,sans-serif;color:#031a35">'
        . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">'
        . '<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:18px;padding:32px">'
        . '<tr><td>' . $logo . '<h1 style="font-size:22px;margin:24px 0 12px">' . htmlspecialchars($title) . '</h1>'
        . '<div style="font-size:15px;line-height:1.6;color:#2b4059">' . $bodyHtml . '</div>' . $button
        . '<p style="margin:28px 0 0;font-size:12px;color:#6b7c93">BIM FLOW · By Vertex — Más eficiencia, más proyectos</p>'
        . '</td></tr></table></td></tr></table></body></html>';
}

function xp_send_mail(string $to, string $subject, string $html, string $text = ''): bool
{
    $cfg = xp_mail_cfg();
    $driver = $cfg['driver'] ?? 'none';
    if ($driver === 'none' || !filter_var($to, FILTER_VALIDATE_EMAIL) || preg_match('/[\r\n]/', $to . $subject)) {
        return false;
    }
    if ($text === '') {
        $text = trim(html_entity_decode(strip_tags(preg_replace('#<(br|/p|/div|/h1)>#i', "\n", $html)), ENT_QUOTES, 'UTF-8'));
    }
    try {
        if ($driver === 'log') {
            $path = $cfg['path'] ?? (__DIR__ . '/data/mail.log');
            if (!is_dir(dirname($path))) {
                mkdir(dirname($path), 0700, true);
            }
            file_put_contents($path, json_encode(['time' => time(), 'to' => $to, 'subject' => $subject, 'text' => $text, 'html' => $html], JSON_UNESCAPED_UNICODE) . "\n", FILE_APPEND | LOCK_EX);
            return true;
        }
        if ($driver === 'smtp') {
            xp_smtp_send($cfg, $to, $subject, $html, $text);
            return true;
        }
        error_log('[xportbim-mail] driver desconocido: ' . $driver);
    } catch (Throwable $e) {
        error_log('[xportbim-mail] ' . $e->getMessage());
    }
    return false;
}

function xp_mail_encode_header(string $value): string
{
    return preg_match('/^[\x20-\x7e]*$/', $value) ? $value : '=?UTF-8?B?' . base64_encode($value) . '?=';
}

function xp_mail_build(array $c, string $to, string $subject, string $html, string $text): string
{
    $boundary = 'bf_' . bin2hex(random_bytes(12));
    $host = parse_url(xp_base_url(), PHP_URL_HOST) ?: 'localhost';
    $fromName = xp_mail_encode_header(str_replace(['"', "\r", "\n"], '', (string) ($c['from_name'] ?? 'BIM FLOW')));
    $h = [
        'From: ' . $fromName . ' <' . $c['from_email'] . '>',
        'To: <' . $to . '>',
        'Subject: ' . xp_mail_encode_header($subject),
        'Date: ' . gmdate('D, d M Y H:i:s') . ' +0000',
        'Message-ID: <' . bin2hex(random_bytes(12)) . '@' . $host . '>',
        'MIME-Version: 1.0',
        'Content-Type: multipart/alternative; boundary="' . $boundary . '"',
    ];
    $part = function (string $type, string $body): string {
        return 'Content-Type: ' . $type . "; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" . chunk_split(base64_encode($body), 76, "\r\n");
    };
    return implode("\r\n", $h) . "\r\n\r\n--" . $boundary . "\r\n" . $part('text/plain', $text) . '--' . $boundary . "\r\n" . $part('text/html', $html) . '--' . $boundary . "--\r\n";
}

/** Cliente SMTP mínimo: EHLO, STARTTLS o SSL implícito, AUTH LOGIN, MAIL/RCPT/DATA. Lanza excepción si algo falla. */
function xp_smtp_send(array $c, string $to, string $subject, string $html, string $text): void
{
    foreach (['host', 'from_email'] as $required) {
        if (empty($c[$required])) {
            throw new RuntimeException("SMTP: falta '$required' en la configuración.");
        }
    }
    if (!filter_var($c['from_email'], FILTER_VALIDATE_EMAIL) || preg_match('/[\r\n]/', (string) $c['from_email'])) {
        throw new RuntimeException('SMTP: correo remitente inválido.');
    }
    $enc = $c['encryption'] ?? 'tls';
    $port = (int) ($c['port'] ?? ($enc === 'ssl' ? 465 : 587));
    $verify = $c['verify_peer'] ?? true;
    $context = stream_context_create(['ssl' => ['verify_peer' => $verify, 'verify_peer_name' => $verify, 'SNI_enabled' => true]]);
    $fp = @stream_socket_client(($enc === 'ssl' ? 'ssl://' : 'tcp://') . $c['host'] . ':' . $port, $errno, $errstr, 15, STREAM_CLIENT_CONNECT, $context);
    if (!$fp) {
        throw new RuntimeException("SMTP: no se pudo conectar a {$c['host']}:$port ($errstr)");
    }
    stream_set_timeout($fp, 20);

    $read = function () use ($fp): array {
        $all = '';
        $code = 0;
        while (($line = fgets($fp, 2048)) !== false) {
            $all .= $line;
            $code = (int) substr($line, 0, 3);
            if (strlen($line) < 4 || $line[3] !== '-') {
                break;
            }
        }
        return [$code, trim($all)];
    };
    $cmd = function (string $line, array $ok, string $label = '') use ($fp, $read): string {
        fwrite($fp, $line . "\r\n");
        [$code, $resp] = $read();
        if (!in_array($code, $ok, true)) {
            throw new RuntimeException('SMTP: respuesta inesperada a ' . ($label ?: strtok($line, ' ')) . ': ' . $resp);
        }
        return $resp;
    };

    try {
        [$code, $banner] = $read();
        if ($code !== 220) {
            throw new RuntimeException('SMTP: el servidor no respondió como se esperaba: ' . $banner);
        }
        $name = parse_url(xp_base_url(), PHP_URL_HOST) ?: 'localhost';
        $cmd("EHLO $name", [250]);
        if ($enc === 'tls') {
            $cmd('STARTTLS', [220]);
            if (!stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
                throw new RuntimeException('SMTP: no se pudo establecer la conexión cifrada (STARTTLS).');
            }
            $cmd("EHLO $name", [250]);
        }
        if (!empty($c['username'])) {
            $cmd('AUTH LOGIN', [334]);
            $cmd(base64_encode((string) $c['username']), [334], 'usuario');
            $cmd(base64_encode((string) ($c['password'] ?? '')), [235], 'contraseña (revise usuario y contraseña SMTP)');
        }
        $cmd('MAIL FROM:<' . $c['from_email'] . '>', [250]);
        $cmd('RCPT TO:<' . $to . '>', [250, 251]);
        $cmd('DATA', [354]);
        $message = preg_replace('/^\./m', '..', xp_mail_build($c, $to, $subject, $html, $text));
        fwrite($fp, $message . "\r\n.\r\n");
        [$code, $resp] = $read();
        if ($code !== 250) {
            throw new RuntimeException('SMTP: el servidor rechazó el mensaje: ' . $resp);
        }
        @fwrite($fp, "QUIT\r\n");
    } finally {
        @fclose($fp);
    }
}
