<?php
// Configuración inicial (se ejecuta una sola vez, por SSH):
//   php app/bin/setup.php                    asistente interactivo
//   php app/bin/setup.php --reset-password   genera otra contraseña de administrador
//   php app/bin/setup.php --public-key       muestra la clave pública para compilar el complemento
//   php app/bin/setup.php --migrate          aplica cambios de esquema tras actualizar el código (idempotente)
//   php app/bin/setup.php --payment-mode=test|manual   test aprueba los pedidos al instante (solo pruebas)
//   php app/bin/setup.php --setup-mail       configura el correo saliente (SMTP) para verificar correos y recuperar contraseñas
//   php app/bin/setup.php --test-mail=a@b.c  envía un correo de prueba
//   php app/bin/setup.php --ip-header=HTTP_CF_CONNECTING_IP|HTTP_X_FORWARDED_FOR|REMOTE_ADDR   de dónde tomar la IP del cliente
//   php app/bin/setup.php --public-url=https://dominio   URL base que usan los enlaces de los correos
//   php app/bin/setup.php --admin-email=a@b.c   correo al que avisar de pedidos por aprobar
//   php app/bin/setup.php --force            REGENERA la clave de firma (invalida todas las DLL ya repartidas)
// Variables de entorno opcionales (modo no interactivo): XP_DRIVER=mysql|sqlite, XP_DB_HOST, XP_DB_NAME,
// XP_DB_USER, XP_DB_PASS, XP_SQLITE_PATH, XP_IP_HEADER.
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

$appDir = dirname(__DIR__);
$configFile = $appDir . '/config.php';
$flags = array_slice($argv, 1);

foreach (['openssl', 'pdo', 'mbstring'] as $ext) {
    if (!extension_loaded($ext)) {
        fwrite(STDERR, "Falta la extensión PHP '$ext'.\n");
        exit(1);
    }
}

function ask(string $label, string $envName, string $default = '', bool $secret = false): string
{
    $env = getenv($envName);
    if ($env !== false && $env !== '') {
        return $env;
    }
    echo $label . ($default !== '' && !$secret ? " [$default]" : '') . ': ';
    if ($secret && DIRECTORY_SEPARATOR === '/') {
        shell_exec('stty -echo');
    }
    $line = trim((string) fgets(STDIN));
    if ($secret && DIRECTORY_SEPARATOR === '/') {
        shell_exec('stty echo');
        echo "\n";
    }
    return $line === '' ? $default : $line;
}

function write_config(string $file, array $config): void
{
    $php = "<?php
// Generado por app/bin/setup.php. Contiene secretos: no lo suba a git ni lo exponga.
return " . var_export($config, true) . ";
";
    file_put_contents($file, $php);
    @chmod($file, 0600);
    allow_web_user_to_read($file);
}

/**
 * En hosting con usuarios separados (Cloudways) el asistente corre como un usuario y PHP-FPM como el dueño de la
 * aplicación. Se le concede lectura solo a ese usuario (ACL); si no hay ACL, se usa el grupo del sitio.
 */
function allow_web_user_to_read(string $file): void
{
    $site = dirname($file, 2);
    if (basename($site) !== 'public_html' && is_dir($site . '/public_html')) {
        $site .= '/public_html';
    }
    $uid = @fileowner($site);
    if ($uid === false || $uid === @fileowner($file)) {
        return; // mismo usuario: nada que hacer
    }
    $owner = function_exists('posix_getpwuid') ? (posix_getpwuid($uid)['name'] ?? '') : '';
    if ($owner === '' && function_exists('shell_exec')) {
        $owner = trim((string) @shell_exec('stat -c %U ' . escapeshellarg($site) . ' 2>/dev/null'));
    }
    if ($owner !== '' && function_exists('exec')) {
        @exec('setfacl -m u:' . escapeshellarg($owner) . ':r ' . escapeshellarg($file) . ' 2>/dev/null', $out, $rc);
        if ($rc === 0) {
            return;
        }
    }
    @chgrp($file, (int) @filegroup($site));
    @chmod($file, 0640);
    echo "Aviso: si el sitio responde con error 500, concédale lectura a '" . ($owner ?: 'el usuario de la aplicación') . "':
  setfacl -m u:" . ($owner ?: 'USUARIO') . ":r $file
";
}

/** Crea tablas faltantes y agrega columnas nuevas. Seguro de repetir. */
function migrate_schema(PDO $pdo, string $driver, string $appDir): void
{
    $schema = file_get_contents($appDir . '/schema.' . $driver . '.sql');
    foreach (array_filter(array_map('trim', explode(';', $schema))) as $statement) {
        $pdo->exec($statement);
    }
    $sqlite = $driver === 'sqlite';
    $wanted = [
        'licenses' => [
            'customer_id' => $sqlite ? 'TEXT' : 'CHAR(36) NULL',
            'key_enc' => $sqlite ? 'TEXT' : 'TEXT NULL',
            'is_trial' => $sqlite ? 'INTEGER NOT NULL DEFAULT 0' : 'TINYINT NOT NULL DEFAULT 0',
        ],
        'customers' => [
            'email_norm' => $sqlite ? 'TEXT' : 'VARCHAR(160) NULL',
            'email_verified_at' => $sqlite ? 'INTEGER' : 'BIGINT NULL',
            'session_version' => $sqlite ? 'INTEGER NOT NULL DEFAULT 0' : 'INT NOT NULL DEFAULT 0',
        ],
        'orders' => ['tier' => $sqlite ? 'INTEGER NOT NULL DEFAULT 0' : 'INT NOT NULL DEFAULT 0'],
    ];
    foreach ($wanted as $table => $columns) {
        $have = [];
        if ($sqlite) {
            foreach ($pdo->query("PRAGMA table_info($table)") as $row) {
                $have[$row['name']] = true;
            }
        } else {
            foreach ($pdo->query("SHOW COLUMNS FROM $table") as $row) {
                $have[$row['Field']] = true;
            }
        }
        foreach ($columns as $name => $type) {
            if (!isset($have[$name])) {
                $pdo->exec("ALTER TABLE $table ADD COLUMN $name $type");
                echo "Columna agregada: $table.$name\n";
                if ($table === 'customers' && $name === 'email_verified_at') {
                    // Clientes anteriores a la verificación de correo: se consideran verificados para no bloquearlos.
                    $pdo->exec('UPDATE customers SET email_verified_at = created_at');
                }
            }
        }
    }
    // Clientes creados antes de existir email_norm: se rellena para que el control de duplicados los incluya.
    require_once $appDir . '/bootstrap.php';
    foreach ($pdo->query("SELECT id, email FROM customers WHERE email_norm IS NULL")->fetchAll(PDO::FETCH_ASSOC) as $c) {
        $st = $pdo->prepare('UPDATE customers SET email_norm = ? WHERE id = ?');
        $st->execute([xp_normalize_email($c['email']), $c['id']]);
    }
}

function open_pdo(array $db): PDO
{
    $pdo = $db['driver'] === 'sqlite'
        ? new PDO('sqlite:' . $db['path'])
        : new PDO('mysql:host=' . $db['host'] . ';dbname=' . $db['name'] . ';charset=utf8mb4', $db['user'], $db['pass']);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    return $pdo;
}

function public_key_info(string $pem): array
{
    $key = openssl_pkey_get_private($pem);
    $ec = openssl_pkey_get_details($key)['ec'];
    $x = str_pad($ec['x'], 32, "\x00", STR_PAD_LEFT);
    $y = str_pad($ec['y'], 32, "\x00", STR_PAD_LEFT);
    return ['x' => base64_encode($x), 'y' => base64_encode($y)];
}

function print_public_key(array $info): void
{
    echo "\n=== CLAVE PÚBLICA (para compilar el complemento de Revit) ===\n";
    echo "LICENSE_PUBLIC_KEY_X = {$info['x']}\n";
    echo "LICENSE_PUBLIC_KEY_Y = {$info['y']}\n";
}

function new_password(): array
{
    $plain = rtrim(strtr(base64_encode(random_bytes(15)), '+/', 'AB'), '=');
    return [$plain, password_hash($plain, PASSWORD_DEFAULT)];
}

$exists = is_file($configFile);

if (in_array('--public-key', $flags, true)) {
    if (!$exists) {
        fwrite(STDERR, "Aún no hay configuración.\n");
        exit(1);
    }
    $config = require $configFile;
    print_public_key(public_key_info($config['signing_key_pem']));
    exit(0);
}

if (in_array('--reset-password', $flags, true)) {
    if (!$exists) {
        fwrite(STDERR, "Aún no hay configuración.\n");
        exit(1);
    }
    $config = require $configFile;
    [$plain, $hash] = new_password();
    $config['admin_password_hash'] = $hash;
    write_config($configFile, $config);
    echo "Nueva contraseña del panel (anótela ahora, no se vuelve a mostrar): $plain\n";
    exit(0);
}

foreach ($flags as $flag) {
    if (strpos($flag, '--public-url=') === 0) {
        $url = rtrim(substr($flag, strlen('--public-url=')), '/');
        if (!$exists || !preg_match('#^https?://[^/\s]+$#', $url)) {
            fwrite(STDERR, "Uso: php app/bin/setup.php --public-url=https://bimflow.midominio.com (sin ruta final)\n");
            exit(1);
        }
        $config = require $configFile;
        $config['public_url'] = $url;
        write_config($configFile, $config);
        echo "URL pública guardada: $url (se usa en los enlaces de los correos).\n";
        exit(0);
    }
    if (strpos($flag, '--admin-email=') === 0) {
        $addr = substr($flag, strlen('--admin-email='));
        if (!$exists || !filter_var($addr, FILTER_VALIDATE_EMAIL)) {
            fwrite(STDERR, "Uso: php app/bin/setup.php --admin-email=tu@correo.com\n");
            exit(1);
        }
        $config = require $configFile;
        $config['admin_email'] = $addr;
        write_config($configFile, $config);
        echo "Se te avisará a $addr cuando haya pedidos por aprobar.\n";
        exit(0);
    }
}

if (in_array('--setup-mail', $flags, true)) {
    if (!$exists) {
        fwrite(STDERR, "Aún no hay configuración. Ejecute primero el asistente sin opciones.\n");
        exit(1);
    }
    $config = require $configFile;
    echo "Configuración del correo saliente (SMTP). Déjelo en blanco para conservar el valor actual.\n";
    $cur = $config['mail'] ?? [];
    $mail = [
        'driver' => 'smtp',
        'host' => ask('Servidor SMTP (ej. smtp-relay.brevo.com, smtp.gmail.com)', 'XP_MAIL_HOST', $cur['host'] ?? ''),
        'port' => (int) ask('Puerto', 'XP_MAIL_PORT', (string) ($cur['port'] ?? 587)),
        'encryption' => strtolower(ask('Cifrado (tls = STARTTLS en 587, ssl = 465, none)', 'XP_MAIL_ENC', $cur['encryption'] ?? 'tls')),
        'username' => ask('Usuario SMTP', 'XP_MAIL_USER', $cur['username'] ?? ''),
        'password' => ask('Contraseña SMTP', 'XP_MAIL_PASS', $cur['password'] ?? '', true),
        'from_email' => ask('Correo remitente (ej. no-reply@bimflow.midominio.com)', 'XP_MAIL_FROM', $cur['from_email'] ?? ''),
        'from_name' => ask('Nombre del remitente', 'XP_MAIL_FROM_NAME', $cur['from_name'] ?? 'BIM FLOW'),
    ];
    if ($mail['host'] === '' || !filter_var($mail['from_email'], FILTER_VALIDATE_EMAIL) || !in_array($mail['encryption'], ['tls', 'ssl', 'none'], true)) {
        fwrite(STDERR, "Datos incompletos o inválidos (servidor, remitente o cifrado).\n");
        exit(1);
    }
    $config['mail'] = $mail;
    if (empty($config['public_url'])) {
        echo "Aviso: falta la URL pública de los enlaces. Ejecute: php app/bin/setup.php --public-url=https://su-dominio\n";
    }
    write_config($configFile, $config);
    echo "Correo configurado. Pruébelo con: php app/bin/setup.php --test-mail=su@correo.com\n";
    exit(0);
}

foreach ($flags as $flag) {
    if (strpos($flag, '--test-mail=') === 0) {
        $to = substr($flag, strlen('--test-mail='));
        if (!$exists || !filter_var($to, FILTER_VALIDATE_EMAIL)) {
            fwrite(STDERR, "Uso: php app/bin/setup.php --test-mail=destino@correo.com\n");
            exit(1);
        }
        require_once $appDir . '/bootstrap.php';
        if (!xp_mail_enabled()) {
            fwrite(STDERR, "El correo no está configurado. Ejecute: php app/bin/setup.php --setup-mail\n");
            exit(1);
        }
        $ok = xp_send_mail($to, 'Prueba de correo de BIM FLOW', xp_mail_template('Prueba de correo', '<p>Si lees esto, el servidor ya puede enviar correos.</p>', null, null), 'Si lees esto, el servidor ya puede enviar correos.');
        echo $ok ? "Correo de prueba enviado a $to. Revise también la carpeta de spam.\n" : "No se pudo enviar. Revise el error en el log de PHP de la aplicación (logs/*error*.log).\n";
        exit($ok ? 0 : 1);
    }
}

foreach ($flags as $flag) {
    if (strpos($flag, '--payment-mode=') === 0) {
        $mode = substr($flag, strlen('--payment-mode='));
        if (!$exists || !in_array($mode, ['manual', 'test'], true)) {
            fwrite(STDERR, "Uso: php app/bin/setup.php --payment-mode=manual|test (requiere configuración existente)\n");
            exit(1);
        }
        $config = require $configFile;
        $config['payment_mode'] = $mode;
        write_config($configFile, $config);
        echo $mode === 'test'
            ? "Modo de pago: PRUEBA. Los pedidos se aprueban al instante (no usar con clientes reales).\n"
            : "Modo de pago: MANUAL. El administrador aprueba cada pedido en el panel.\n";
        exit(0);
    }
}

if (in_array('--migrate', $flags, true)) {
    if (!$exists) {
        fwrite(STDERR, "Aún no hay configuración. Ejecute primero el asistente sin opciones.\n");
        exit(1);
    }
    $config = require $configFile;
    migrate_schema(open_pdo($config['db']), $config['db']['driver'], $appDir);
    echo "Esquema al día.\n";
    exit(0);
}

if ($exists && !in_array('--force', $flags, true)) {
    fwrite(STDERR, "Ya existe $configFile.\nNo se sobrescribe para no perder la clave de firma. Use --reset-password o --public-key.\n");
    exit(1);
}

// ---- base de datos
$driver = strtolower(ask('Base de datos (mysql o sqlite)', 'XP_DRIVER', 'mysql'));
if ($driver === 'sqlite') {
    $dataDir = $appDir . '/data';
    if (!is_dir($dataDir)) {
        mkdir($dataDir, 0700, true);
    }
    file_put_contents($dataDir . '/.htaccess', "Require all denied\n");
    $db = ['driver' => 'sqlite', 'path' => ask('Ruta del archivo SQLite', 'XP_SQLITE_PATH', $dataDir . '/licenses.sqlite')];
} else {
    $db = [
        'driver' => 'mysql',
        'host' => ask('Servidor MySQL', 'XP_DB_HOST', 'localhost'),
        'name' => ask('Nombre de la base de datos', 'XP_DB_NAME'),
        'user' => ask('Usuario de la base de datos', 'XP_DB_USER'),
        'pass' => ask('Contraseña de la base de datos', 'XP_DB_PASS', '', true),
    ];
}

try {
    $pdo = open_pdo($db);
} catch (Throwable $e) {
    fwrite(STDERR, 'No se pudo conectar a la base de datos: ' . $e->getMessage() . "\n");
    exit(1);
}

// ---- esquema
migrate_schema($pdo, $db['driver'], $appDir);
echo "Tablas listas.\n";

// ---- claves y secretos
$key = openssl_pkey_new(['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC]);
if ($key === false) {
    fwrite(STDERR, 'OpenSSL no pudo generar la clave de firma (prime256v1): ' . openssl_error_string() . "\n");
    exit(1);
}
openssl_pkey_export($key, $pem);
[$plain, $hash] = new_password();

$config = [
    'db' => $db,
    'signing_key_pem' => $pem,
    'session_secret' => bin2hex(random_bytes(32)),
    'admin_password_hash' => $hash,
    'offline_grace_days' => 7,
    // 'manual': el cliente paga fuera de línea y el administrador aprueba el pedido. 'test': aprueba al instante (solo pruebas).
    'payment_mode' => getenv('XP_PAYMENT_MODE') ?: 'manual',
    'mail' => getenv('XP_MAIL_DRIVER') === 'log'
        ? ['driver' => 'log', 'path' => getenv('XP_MAIL_LOG') ?: ($appDir . '/data/mail.log'), 'from_email' => 'no-reply@example.test', 'from_name' => 'BIM FLOW']
        : ['driver' => 'none'],
    'admin_email' => getenv('XP_ADMIN_EMAIL') ?: '',
    'payment_instructions' => 'Realice el pago indicando el código del pedido como referencia y envíe el comprobante a soporte. Activaremos su licencia en cuanto se confirme.',
    // Encabezado del que se toma la IP del cliente (detrás de Nginx/Varnish de Cloudways suele ser este).
    'ip_header' => getenv('XP_IP_HEADER') ?: 'HTTP_X_FORWARDED_FOR',
];
write_config($configFile, $config);

echo "\nConfiguración guardada en $configFile\n";
echo "\n=== CONTRASEÑA DEL PANEL (anótela ahora, no se vuelve a mostrar) ===\n$plain\n";
print_public_key(public_key_info($pem));
echo "\nGuarde también una copia de la clave de firma: si se pierde, hay que recompilar y repartir de nuevo el complemento.\n";
