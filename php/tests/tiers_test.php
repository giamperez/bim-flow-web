<?php
// Prueba de los tramos de precio y del congelamiento de precio (CLI, usa la base de app/config.php: solo desarrollo).
//   XP_DRIVER=sqlite XP_SQLITE_PATH=... php app/bin/setup.php   (una vez)   y luego   php php/tests/tiers_test.php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    exit(1);
}
$configFile = __DIR__ . '/../app/config.php';
if (!is_file($configFile)) {
    fwrite(STDERR, "Falta php/app/config.php (ejecute app/bin/setup.php con SQLite primero).\n");
    exit(2);
}
$config = require $configFile;
$config['pricing_tiers'] = [
    ['name' => 'Uno', 'until' => 1, 'trial_days' => 7, 'prices' => ['mensual' => 1000, 'anual' => 10000]],
    ['name' => 'Dos', 'until' => 3, 'trial_days' => 7, 'prices' => ['mensual' => 1500, 'anual' => 15000]],
    ['name' => 'Tres', 'until' => null, 'trial_days' => 5, 'prices' => ['mensual' => 2000, 'anual' => 20000]],
];
unset($config['plans']);
$config['price_lock'] = true;
file_put_contents($configFile, "<?php\nreturn " . var_export($config, true) . ";\n");

require __DIR__ . '/../app/bootstrap.php';

$pass = 0;
$fail = 0;
function check(string $name, bool $ok, string $extra = ''): void
{
    global $pass, $fail;
    if ($ok) {
        $pass++;
    } else {
        $fail++;
        echo "  ✗ FALLO: $name $extra\n";
    }
}
function price(array $plans, string $id): int
{
    foreach ($plans as $p) {
        if ($p['id'] === $id) {
            return $p['priceCents'];
        }
    }
    return -1;
}
function customer(string $label): array
{
    $id = xp_uuid();
    xp_exec('INSERT INTO customers (id, email, email_norm, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)', [$id, "$label@example.test", "$label@example.test", $label, 'x', time()]);
    return xp_one('SELECT * FROM customers WHERE id = ?', [$id]);
}
function paid(array $c, int $tier, int $cents = 1000): void
{
    xp_exec(
        "INSERT INTO orders (id, code, customer_id, plan_id, plan_name, seconds, devices, kind, amount_cents, currency, status, provider, tier, created_at, paid_at)
         VALUES (?, ?, ?, 'mensual', 'Mensual', 2592000, 1, 'new', ?, 'USD', 'paid', 'manual', ?, ?, ?)",
        [xp_uuid(), 'BF-' . strtoupper(substr(bin2hex(random_bytes(4)), 0, 6)), $c['id'], $cents, $tier, time(), time()]
    );
}

$stamp = (string) time();
echo "Tramos de precio\n";
$visitor = null;
check('tramo inicial = 0 con 0 clientes de pago', xp_current_tier() === 0);
check('precio mensual del tramo Uno', price(xp_plans($visitor), 'mensual') === 1000);
$info = xp_tier_info();
check('quedan 1 cupo y se anuncia el siguiente precio', $info['name'] === 'Uno' && $info['slotsLeft'] === 1 && $info['nextPrices']['mensual'] === 1500 && $info['nextName'] === 'Dos', json_encode($info));
$trial = array_values(array_filter(xp_plans(null), fn($p) => $p['trial']))[0];
check('la prueba dura 7 días en el tramo Uno', $trial['seconds'] === 7 * 86400 && $trial['priceCents'] === 0);

$p1 = customer("p1.$stamp");
paid($p1, 0);
check('con 1 cliente de pago pasa al tramo Dos', xp_current_tier() === 1 && xp_tier_info()['name'] === 'Dos');
$newbie = customer("nuevo.$stamp");
check('un cliente nuevo ve el precio del tramo Dos', price(xp_plans($newbie), 'mensual') === 1500);
check('quien compró en el tramo Uno CONSERVA su precio', price(xp_plans($p1), 'mensual') === 1000 && price(xp_plans($p1), 'anual') === 10000);

$p2 = customer("p2.$stamp");
paid($p2, 1, 1500);
$p3 = customer("p3.$stamp");
paid($p3, 1, 1500);
check('con 3 clientes de pago pasa al tramo Tres', xp_current_tier() === 2 && xp_tier_info()['slotsLeft'] === null && xp_tier_info()['nextPrices'] === null);
check('el tramo Tres cuesta 2000 y la prueba baja a 5 días', price(xp_plans($newbie), 'mensual') === 2000 && array_values(array_filter(xp_plans($newbie), fn($p) => $p['trial']))[0]['seconds'] === 5 * 86400);
check('p1 sigue pagando 1000 y p2 sigue en 1500', price(xp_plans($p1), 'mensual') === 1000 && price(xp_plans($p2), 'mensual') === 1500);

echo "Pedidos gratis y pendientes no cuentan como cliente de pago\n";
$free = customer("gratis.$stamp");
xp_exec("INSERT INTO orders (id, code, customer_id, plan_id, plan_name, seconds, devices, kind, amount_cents, currency, status, provider, tier, created_at, paid_at) VALUES (?, ?, ?, 'prueba', 'Prueba gratis', 604800, 1, 'trial', 0, 'USD', 'paid', 'manual', 0, ?, ?)", [xp_uuid(), 'BF-GRATIS', $free['id'], time(), time()]);
$pend = customer("pendiente.$stamp");
xp_exec("INSERT INTO orders (id, code, customer_id, plan_id, plan_name, seconds, devices, kind, amount_cents, currency, status, provider, tier, created_at) VALUES (?, ?, ?, 'mensual', 'Mensual', 2592000, 1, 'new', 1500, 'USD', 'pending', 'manual', 1, ?)", [xp_uuid(), 'BF-PEND', $pend['id'], time()]);
check('siguen siendo 3 clientes de pago', xp_paying_customers() === 3, (string) xp_paying_customers());

echo "Sin congelamiento de precio\n";
$config['price_lock'] = false;
file_put_contents($configFile, "<?php\nreturn " . var_export($config, true) . ";\n");
// xp_config() ya está en memoria en este proceso: se prueba el efecto con un proceso nuevo.
$probe = tempnam(sys_get_temp_dir(), 'tiers') . '.php';
file_put_contents($probe, '<?php require ' . var_export(__DIR__ . '/../app/bootstrap.php', true) . ';'
    . '$c = xp_one("SELECT * FROM customers WHERE email = ?", [' . var_export("p1.$stamp@example.test", true) . ']);'
    . 'foreach (xp_plans($c) as $p) { if ($p["id"] === "mensual") echo $p["priceCents"]; }');
$out = trim((string) shell_exec('"' . PHP_BINARY . '" "' . $probe . '"'));
@unlink($probe);
check('con price_lock desactivado p1 paga el precio vigente (2000)', $out === '2000', $out);

echo "Correos\n";
check('alias de Gmail se normalizan', xp_normalize_email('Foo.Bar+promo@Gmail.com') === 'foobar@gmail.com' && xp_normalize_email('a.b@googlemail.com') === 'ab@gmail.com');
check('+etiqueta se quita y los puntos de otros dominios se conservan', xp_normalize_email('juan.perez+x@empresa.com') === 'juan.perez@empresa.com');
check('dominios desechables', xp_is_disposable_email('x@mailinator.com') && xp_is_disposable_email('x@YOPMAIL.com') && !xp_is_disposable_email('x@empresa.com'));

// Se restaura la configuración sin las pruebas.
unset($config['pricing_tiers'], $config['price_lock']);
file_put_contents($configFile, "<?php\nreturn " . var_export($config, true) . ";\n");
echo "\n$pass correctas, $fail fallidas\n";
exit($fail ? 1 : 0);
