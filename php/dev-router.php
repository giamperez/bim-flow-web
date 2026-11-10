<?php
// Solo desarrollo: reproduce .htaccess para `php -S 127.0.0.1:8788 -t php/public php/dev-router.php`.
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (preg_match('#^/(api/v1|admin/api|portal/api)(/|$)#', $path)) {
    require __DIR__ . '/public/index.php';
    return true;
}
$types = ['html' => 'text/html; charset=utf-8', 'js' => 'text/javascript', 'css' => 'text/css', 'svg' => 'image/svg+xml', 'jpg' => 'image/jpeg', 'png' => 'image/png'];
// Páginas estáticas: /admin/, /portal/ y (si existe) la landing compilada en site/.
foreach ([__DIR__ . '/../site', __DIR__ . '/../public', __DIR__ . '/public'] as $root) {
    $rel = ltrim($path, '/');
    if ($rel === '' || substr($rel, -1) === '/') {
        $rel .= 'index.html';
    }
    $file = realpath($root . '/' . $rel);
    $base = realpath($root);
    if ($file && $base && strpos($file, $base) === 0 && is_file($file) && !preg_match('/\.php$/', $file)) {
        header('Content-Type: ' . ($types[strtolower(pathinfo($file, PATHINFO_EXTENSION))] ?? 'application/octet-stream'));
        readfile($file);
        return true;
    }
}
http_response_code(404);
