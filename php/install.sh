#!/usr/bin/env bash
# Instala/actualiza el servidor de licencias en una aplicación PHP vacía de Cloudways.
#   Uso: bash php/install.sh /home/master/applications/<carpeta-de-la-app>
# Es seguro repetirlo para actualizar: no toca app/config.php ni la base de datos.
set -euo pipefail

APP="${1:?Indique la carpeta de la aplicación, p. ej. ~/applications/licencias}"
APP="${APP%/}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
WEB="$APP/public_html"

[ -d "$WEB" ] || { echo "No existe $WEB. Cree primero la aplicación PHP en Cloudways."; exit 1; }
if [ -e "$WEB/wp-config.php" ] || [ -e "$WEB/wp-content" ]; then
  echo "Esa aplicación es un WordPress. Use una aplicación PHP nueva y separada."; exit 1
fi

mkdir -p "$APP/app" "$WEB/admin"
cp -r "$HERE/app/." "$APP/app/"
cp "$HERE/public/index.php" "$HERE/public/.htaccess" "$WEB/"
cp "$ROOT/public/admin/index.html" "$WEB/admin/index.html"
echo "Archivos copiados a $APP"

if [ ! -f "$APP/app/config.php" ]; then
  echo "Primera instalación: ejecutando el asistente de configuración..."
  php "$APP/app/bin/setup.php"
else
  echo "Ya existe app/config.php: se conserva la configuración y las claves."
fi
