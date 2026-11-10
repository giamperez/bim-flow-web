# bim-flow-web · Servidor de licencias de XportBIM

Valida las licencias del complemento de Revit y ofrece un panel para gestionarlas. Hay **dos implementaciones con los mismos endpoints** y el mismo panel (`public/admin/index.html`):

| Carpeta | Para | Base de datos |
|---|---|---|
| `src/` + `wrangler.toml` | Cloudflare Workers | D1 |
| `php/` | Hosting PHP (Cloudways, cPanel…) | MySQL o SQLite |

El complemento no distingue cuál responde: solo necesita la URL (HTTPS) y la clave pública.

## Cómo funciona
- Clave de licencia `XPBM-XXXXX-XXXXX-XXXXX-XXXXX`. En la base solo se guarda su hash; se muestra una vez al crearla.
- `POST /api/v1/activate | validate | deactivate | release`. Devuelve un token firmado (ECDSA P-256 / SHA-256, firma `r||s`) ligado al equipo, con vencimiento y fecha de reverificación (7 días sin internet).
- Cada licencia admite N equipos. Un equipo se libera desde el panel, desde el propio complemento o (máx. 3 veces cada 30 días) con la clave.
- Límites: 20 claves inválidas por hora por IP; 5 logins fallidos del panel por IP cada 15 min.

## Instalar en Cloudways (PHP)
1. En Cloudways crea una **aplicación PHP vacía** (no WordPress) y asígnale un dominio o subdominio con **SSL** (por ejemplo `licencias.midominio.com`). Anota la carpeta de la aplicación (`ls ~/applications`) y las credenciales de su base MySQL (*Access Details*).
2. Por SSH:
   ```bash
   git clone https://github.com/giamperez/bim-flow-web.git ~/bim-flow-web
   bash ~/bim-flow-web/php/install.sh ~/applications/<carpeta-de-la-app>
   ```
   El asistente pide los datos de MySQL (o elige `sqlite`), crea las tablas, genera la clave de firma y una contraseña de administrador, y muestra la **clave pública** para compilar el complemento. Anótalo todo y guarda una copia de `app/config.php` (contiene la clave de firma).
3. Abre `https://<tu-dominio>/admin/` e inicia sesión.
4. Comprueba la instalación desde tu PC:
   ```bash
   BASE_URL=https://<tu-dominio> ADMIN_PASSWORD=... PUBLIC_KEY_X=... PUBLIC_KEY_Y=... node test/e2e.mjs
   ```
5. En el repositorio del complemento define las variables `LICENSE_SERVER_URL`, `LICENSE_PUBLIC_KEY_X` y `LICENSE_PUBLIC_KEY_Y`.

Actualizar: `cd ~/bim-flow-web && git pull && bash php/install.sh ~/applications/<app>` (conserva `config.php` y los datos).
Otra contraseña: `php app/bin/setup.php --reset-password`. Ver la clave pública: `php app/bin/setup.php --public-key`.

> Si cambias la clave de firma (`--force`), todas las DLL repartidas dejan de aceptar licencias. No lo hagas salvo que sea imprescindible.

## Cloudflare Workers
```bash
npm install
npm run keys                           # par de claves; guarda la privada
npx wrangler d1 create bimflow         # pon el id en wrangler.toml
npm run db:migrate:remote
npx wrangler secret put SIGNING_KEY_JWK && npx wrangler secret put ADMIN_PASSWORD && npx wrangler secret put SESSION_SECRET
npm run deploy
```

## Desarrollo y pruebas
- Worker: `npm run keys -- --dev`, `npm run db:migrate:local`, `npm run dev`, y en otra terminal `node test/e2e.mjs`. `npm test` ejecuta las pruebas de criptografía.
- PHP: `php app/bin/setup.php` con `XP_DRIVER=sqlite`, luego `php -S 127.0.0.1:8788 -t php/public php/dev-router.php` y `test/e2e.mjs` con `BASE_URL`, `ADMIN_PASSWORD`, `PUBLIC_KEY_X` y `PUBLIC_KEY_Y`. La suite es la misma (48 comprobaciones).
