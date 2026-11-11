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

# app/ (código y config.php) va junto a public_html si hay permiso; si no, dentro de ella, protegida por .htaccess.
if mkdir -p "$APP/app" 2>/dev/null && [ -w "$APP/app" ]; then
  APPDIR="$APP/app"
else
  APPDIR="$WEB/app"
  echo "Aviso: no se puede escribir en $APP; se usa $APPDIR (protegida con .htaccess)."
  mkdir -p "$APPDIR"
fi
mkdir -p "$WEB/admin"

mkdir -p "$WEB/portal" "$WEB/instalacion" "$WEB/downloads"

cp -r "$HERE/app/." "$APPDIR/" \
  && cp "$HERE/public/index.php" "$HERE/public/.htaccess" "$WEB/" \
  && cp "$ROOT/public/admin/index.html" "$WEB/admin/index.html" \
  && cp "$ROOT/public/portal/index.html" "$WEB/portal/index.html" \
  && cp "$ROOT/public/portal/portal.css" "$ROOT/public/portal/.htaccess" "$WEB/portal/" \
  && cp "$ROOT/public/instalacion/index.html" "$WEB/instalacion/index.html" \
  && cp -r "$ROOT/site/." "$WEB/" \
  || { echo "No se pudieron copiar los archivos (permisos). Revise que el usuario pueda escribir en $WEB"; exit 1; }
echo "Archivos copiados: código en $APPDIR, sitio en $WEB"

if [ ! -f "$APPDIR/config.php" ]; then
  echo "Primera instalación: ejecutando el asistente de configuración..."
  php "$APPDIR/bin/setup.php"
else
  echo "Ya existe config.php: se conserva la configuración y las claves."
  php "$APPDIR/bin/setup.php" --migrate
fi

echo
echo "Listo. Landing:  /    Portal:  /portal/    Instalación:  /instalacion/    Administración:  /admin/"
