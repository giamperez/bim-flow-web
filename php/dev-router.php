<?php
// Solo desarrollo: reproduce .htaccess para `php -S 127.0.0.1:8788 -t php/public php/dev-router.php`.
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (preg_match('#^/(api/v1|admin/api)(/|$)#', $path) || $path === '/') {
    require __DIR__ . '/public/index.php';
    return true;
}
if (strpos($path, '/admin/') === 0) {
    $file = realpath(__DIR__ . '/../public/admin/' . (substr($path, 7) ?: 'index.html'));
    if ($file && strpos($file, realpath(__DIR__ . '/../public/admin')) === 0 && is_file($file)) {
        header('Content-Type: text/html; charset=utf-8');
        readfile($file);
        return true;
    }
}
http_response_code(404);
