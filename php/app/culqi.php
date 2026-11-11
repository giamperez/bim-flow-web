<?php
// Cobros con Culqi (Perú). Flujo: el navegador obtiene un token con la llave PÚBLICA y el servidor crea el cargo con la
// llave PRIVADA (que nunca sale del servidor). El monto se toma siempre de la base de datos, jamás del navegador.
declare(strict_types=1);

/** @return array<string,mixed> */
function xp_culqi_cfg(): array
{
    return xp_config()['culqi'] ?? [];
}

function xp_culqi_enabled(): bool
{
    $c = xp_culqi_cfg();
    return !empty($c['public_key']) && !empty($c['secret_key']);
}

/** 'live' o 'test' según el prefijo de la llave. */
function xp_culqi_environment(): string
{
    return strpos((string) (xp_culqi_cfg()['secret_key'] ?? ''), 'sk_live_') === 0 ? 'live' : 'test';
}

/** Solo lo que el navegador necesita para abrir el formulario de pago (nunca la llave privada). */
function xp_culqi_public_info(): ?array
{
    if (!xp_culqi_enabled()) {
        return null;
    }
    return ['provider' => 'culqi', 'publicKey' => (string) xp_culqi_cfg()['public_key'], 'environment' => xp_culqi_environment()];
}

function xp_culqi_api_base(): string
{
    $base = rtrim((string) (xp_culqi_cfg()['api_base'] ?? 'https://api.culqi.com/v2'), '/');
    $host = (string) parse_url($base, PHP_URL_HOST);
    $scheme = (string) parse_url($base, PHP_URL_SCHEME);
    // HTTPS obligatorio, salvo un servidor de pruebas local.
    if ($scheme !== 'https' && !($scheme === 'http' && in_array($host, ['127.0.0.1', 'localhost'], true))) {
        throw new RuntimeException('La URL de la API de Culqi debe usar HTTPS.');
    }
    return $base;
}

/**
 * Petición JSON. Devuelve [status HTTP, cuerpo decodificado|null]; status 0 = sin respuesta (red, timeout).
 *
 * @return array{0:int,1:?array}
 */
function xp_http_json(string $method, string $url, array $headers, ?array $body, int $timeout = 30): array
{
    $payload = $body === null ? null : json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_POSTFIELDS => $payload,
        ]);
        $raw = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        if (PHP_VERSION_ID < 80000) {
            curl_close($ch); // desde PHP 8.0 el recurso se libera solo (y curl_close está obsoleto en 8.5)
        }
    } else {
        $ctx = stream_context_create(['http' => ['method' => $method, 'header' => implode("\r\n", $headers), 'content' => $payload ?? '', 'timeout' => $timeout, 'ignore_errors' => true]]);
        $raw = @file_get_contents($url, false, $ctx);
        $status = 0;
        foreach (($http_response_header ?? []) as $h) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) {
                $status = (int) $m[1];
            }
        }
    }
    if ($raw === false || $raw === null || $status === 0) {
        return [0, null];
    }
    $decoded = json_decode((string) $raw, true);
    return [$status, is_array($decoded) ? $decoded : null];
}

/**
 * Crea el cargo. Resultado:
 *  - ok: cobrado (se devuelve el id del cargo).
 *  - ok=false, definitive=true: Culqi respondió que NO se cobró (tarjeta rechazada, datos inválidos...): se puede reintentar.
 *  - ok=false, definitive=false: no se sabe (sin respuesta, error 5xx): el pedido queda en revisión para no cobrar dos veces.
 *
 * @return array{ok:bool,definitive:bool,chargeId:string,message:string}
 */
function xp_culqi_charge(array $order, array $customer, string $token): array
{
    $body = [
        'amount' => (int) $order['amount_cents'],
        'currency_code' => (string) $order['currency'],
        'email' => (string) $customer['email'],
        'source_id' => $token,
        'description' => mb_substr('BIM FLOW · ' . $order['plan_name'] . ' · ' . $order['code'], 0, 80),
        'metadata' => ['order_code' => (string) $order['code'], 'customer_id' => (string) $customer['id']],
    ];
    $billing = json_decode($customer['billing_json'] ?? '{}', true) ?: [];
    $names = preg_split('/\s+/', trim($customer['name']), 2);
    if (!empty($billing['address']) && !empty($billing['city']) && !empty($customer['phone']) && count($names) === 2) {
        $body['antifraud_details'] = ['first_name' => $names[0], 'last_name' => $names[1],
            'address' => $billing['address'], 'address_city' => $billing['city'], 'country_code' => $billing['country'] ?: 'PE',
            'phone_number' => preg_replace('/\D/', '', $customer['phone'])];
    }
    [$status, $res] = xp_http_json(
        'POST',
        xp_culqi_api_base() . '/charges',
        ['Authorization: Bearer ' . xp_culqi_cfg()['secret_key'], 'Content-Type: application/json'],
        $body
    );
    if ($status === 0 || $status >= 500) {
        return ['ok' => false, 'definitive' => false, 'chargeId' => '', 'message' => 'Culqi no respondió.'];
    }
    $outcome = is_array($res['outcome'] ?? null) ? $res['outcome'] : [];
    if (($status === 200 || $status === 201) && ($res['object'] ?? '') === 'charge' && ($outcome['type'] ?? '') === 'venta_exitosa' && !empty($res['id'])) {
        return ['ok' => true, 'definitive' => true, 'chargeId' => (string) $res['id'], 'message' => ''];
    }
    // "No se cobró" solo se afirma cuando Culqi lo dice sin ambigüedad: error 4xx, sin cargo creado y con un mensaje de error.
    // Cualquier otra respuesta (2xx con un resultado distinto, 3D Secure pendiente, formato inesperado) puede significar que SÍ se
    // cobró: el pedido queda en verificación, sin reintento, y el cargo (si lo hay) se anota para el administrador.
    $isError = ($res['object'] ?? '') === 'error' || isset($res['user_message']) || isset($res['merchant_message']);
    if ($status >= 400 && $status < 500 && $isError && empty($res['id'])) {
        $message = (string) ($res['user_message'] ?? $res['merchant_message'] ?? 'El pago no pudo completarse.');
        return ['ok' => false, 'definitive' => true, 'chargeId' => '', 'message' => mb_substr($message, 0, 200)];
    }
    return ['ok' => false, 'definitive' => false, 'chargeId' => (string) ($res['id'] ?? ''), 'message' => 'Respuesta no reconocida de Culqi.'];
}
