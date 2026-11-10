<?php
// Punto de entrada. La carpeta app/ puede estar junto a public_html (recomendado) o dentro de ella (protegida por .htaccess).
declare(strict_types=1);

$appDir = is_dir(__DIR__ . '/../app') ? __DIR__ . '/../app' : __DIR__ . '/app';
require $appDir . '/bootstrap.php';
xp_dispatch();
