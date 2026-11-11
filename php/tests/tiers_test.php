<?php
// El catalogo fijo reemplaza los tramos. No abre ni modifica bases/config reales.
declare(strict_types=1);
const XP_DAY = 86400;
function xp_config(): array {
    return ['pricing_tiers' => [['prices' => ['mensual' => 99999]]], 'plans' => [['id' => 'anual']]];
}
require __DIR__ . '/../app/portal_api.php';
$plans = xp_plans();
$checks = [
    'siete opciones de catalogo' => count($plans) === 7,
    'precios fijos ignoran overrides antiguos' => array_column($plans, 'priceCents') === [0, 1990, 15900, 4990, 39900, 9990, 79900],
    'capacidad por computadora' => array_column($plans, 'devices') === [1, 1, 1, 3, 3, 7, 7],
    'periodos gratis, mensual y anual' => array_values(array_unique(array_column($plans, 'seconds'))) === [0,30 * XP_DAY,365 * XP_DAY],
    'gratis con 150 archivos mensuales' => $plans[0]['monthlyLimit'] === 150 && $plans[0]['free'],
    'pagados sin limite de archivos' => array_sum(array_column(array_slice($plans, 1), 'monthlyLimit')) === 0,
    'anual disponible' => in_array('anual', array_column($plans, 'id'), true),
    'Gmail normalizado' => xp_normalize_email('Foo.Bar+promo@Gmail.com') === 'foobar@gmail.com',
];
foreach ($checks as $name => $ok) { echo ($ok ? 'OK ' : 'FAIL ') . $name . "\n"; }
exit(in_array(false, $checks, true) ? 1 : 0);
