<?php
declare(strict_types=1);

/**
 * Cifrado en reposo de las referencias de pago de Culqi (cliente y tarjeta guardada).
 *
 * Xport NUNCA recibe ni guarda el número de la tarjeta ni el CVV: el navegador los envía directo a Culqi, que devuelve un
 * token. Lo único que se conserva es una referencia opaca de Culqi (crd_…/cus_…) más la marca y los 4 últimos dígitos.
 * Esa referencia solo sirve junto a la llave secreta de Culqi, y aquí además se guarda cifrada (AES-256-GCM) con una llave
 * propia que vive en config.php y no en la base de datos: quien obtenga solo la base no puede leerla ni usarla.
 * El texto de contexto (AAD) liga cada valor a su dueño: copiar un valor cifrado a otra fila de otro cliente no descifra.
 */
/** Solo para `setup.php --migrate`: usar una llave recién creada sin depender de la copia de config en memoria. */
function xp_vault_set_key(string $hex): void
{
    $GLOBALS['xp_vault_key_override'] = $hex;
}

function xp_vault_key(): string
{
    $hex = (string) ($GLOBALS['xp_vault_key_override'] ?? xp_config()['vault_key'] ?? '');
    if (!preg_match('/^[a-f0-9]{64}$/', $hex)) {
        // Sin llave no se cifra ni se descifra nada: falla en vez de guardar en claro. La crea `setup.php --migrate`.
        throw new RuntimeException('vault_key ausente: ejecute php app/bin/setup.php --migrate');
    }
    return hex2bin($hex);
}

function xp_vault_seal(string $plain, string $aad): string
{
    $iv = random_bytes(12);
    $ct = openssl_encrypt($plain, 'aes-256-gcm', xp_vault_key(), OPENSSL_RAW_DATA, $iv, $tag, $aad, 16);
    if ($ct === false) {
        throw new RuntimeException('No se pudo cifrar la referencia de pago.');
    }
    return 'v1.' . xp_b64u_enc($iv . $tag . $ct);
}

/** Devuelve null si el valor fue alterado o no corresponde a este contexto. Acepta valores antiguos sin cifrar. */
function xp_vault_open(?string $blob, string $aad): ?string
{
    if ($blob === null || $blob === '') {
        return null;
    }
    if (strpos($blob, 'v1.') !== 0) {
        return $blob; // fila anterior al cifrado; `--migrate` la cifra
    }
    $raw = xp_b64u_dec(substr($blob, 3));
    if (strlen($raw) < 29) {
        return null;
    }
    $pt = openssl_decrypt(substr($raw, 28), 'aes-256-gcm', xp_vault_key(), OPENSSL_RAW_DATA, substr($raw, 0, 12), substr($raw, 12, 16), $aad);
    return $pt === false ? null : $pt;
}

function xp_vault_aad(string $kind, string $customerId, string $environment): string
{
    return $kind . '|' . $customerId . '|' . $environment;
}
