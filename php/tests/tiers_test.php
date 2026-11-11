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
    'cuatro planes' => count($plans) === 4,
    'precios fijos ignoran overrides antiguos' => array_column($plans, 'priceCents') === [0, 1990, 4990, 9990],
    'capacidad por computadora' => array_column($plans, 'devices') === [1, 1, 3, 7],
    'todos cubren 30 dias' => array_unique(array_column($plans, 'seconds')) === [30 * XP_DAY],
    'gratis con limite diario' => $plans[0]['dailyLimit'] === 1 && $plans[0]['trial'],
    'pagados sin limite diario' => array_column(array_slice($plans, 1), 'dailyLimit') === [0, 0, 0],
    'sin anual a la venta' => !in_array('anual', array_column($plans, 'id'), true),
    'Gmail normalizado' => xp_normalize_email('Foo.Bar+promo@Gmail.com') === 'foobar@gmail.com',
];
foreach ($checks as $name => $ok) { echo ($ok ? 'OK ' : 'FAIL ') . $name . "\n"; }
exit(in_array(false, $checks, true) ? 1 : 0);
