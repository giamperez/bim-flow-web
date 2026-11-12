# bim-flow-web · Servidor de licencias de XportBIM

Valida las licencias del complemento de Revit y ofrece un panel para gestionarlas. Hay **dos implementaciones con los mismos endpoints** y el mismo panel (`public/admin/index.html`):

| Carpeta | Para | Base de datos |
|---|---|---|
| `src/` + `wrangler.toml` | Cloudflare Workers | D1 |
| `php/` | Hosting PHP (Cloudways, cPanel…) | MySQL o SQLite |

El complemento no distingue cuál responde: solo necesita la URL (HTTPS) y la clave pública.

Modelo comercial vigente, opciones gratuitas, prueba Full, migración y contadores: [Xport por BimFlow](docs/xport-modelo-comercial.md).

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

## Qué incluye el sitio (versión PHP)
| Ruta | Qué es |
|---|---|
| `/` | Landing (código en `landing/`, compilada en `site/`) |
| `/portal/` | **Portal de Xport por BimFlow**: crear cuenta, comprar o renovar, ver y copiar su clave, liberar equipos, regenerar la clave |
| `/admin/` | Panel de administración: licencias, **pedidos por aprobar**, actividad |
| `/api/v1/*` | API del complemento de Revit |

- **Licencias de prueba por minutos:** en el panel, *Nueva licencia* → campo **Prueba corta: minutos** (2, 10 min, 1 hora…). *Extender* admite días o minutos.
- **Compra:** el cliente elige un plan en el portal y se crea un pedido con un código `BF-XXXXXX`. Con `payment_mode: 'manual'` (por defecto) el cliente paga fuera de línea y el administrador pulsa **Aprobar pago** en *Pedidos*; ahí se crea o renueva su licencia. Con `payment_mode: 'test'` el pago se aprueba al instante (solo pruebas; instalar con `XP_PAYMENT_MODE=test`). Para conectar una pasarela, su webhook debe llamar a `xp_mark_order_paid($orderId)` (idempotente).
- **Xport Gratuito:** una computadora, PDF y DWG con ajustes esenciales, y 150 archivos al mes calendario de Perú. Sin vencimiento comercial. La prueba Full se activa por separado durante 14 días y vuelve a Gratuito al terminar.
- **Cupo mensual y prueba Full:** una prueba Full por cuenta y computadora; 150 archivos mensuales por licencia/computadora en Gratuito. Reserva previa y conciliación de archivos realmente generados; fallidos y cancelados devuelven cupo. El cupo se renueva el primer día del mes en Perú.
- **Catálogo fijo en soles:** 1 computadora S/ 19.90 mensual / S/ 159 anual; 3 computadoras S/ 49.90 / S/ 399; 7 computadoras S/ 99.90 / S/ 799. Mensuales por 30 días; anuales por 365. Todos incluyen Full. Pedidos históricos conservados; los pendientes con tarifas antiguas no pueden cobrarse.

- **Panel de usuario:** barra lateral, resumen, licencia y equipos, planes, pedidos, facturación, perfil y seguridad. El perfil permite nombre, empresa, teléfono y correo; cambiar el correo exige contraseña y nueva verificación si hay correo configurado. Cambiar la contraseña invalida las otras sesiones y los enlaces de recuperación anteriores.
- **Tarjetas guardadas:** consentimiento explícito, tokenización con Culqi Checkout, creación de cliente y tarjeta mediante `/v2/customers` y `/v2/cards`. Solo se guarda la referencia de Culqi, marca y últimos cuatro dígitos. Se pueden elegir para pagar o eliminar. No hay suscripciones ni cobros automáticos. Las referencias de prueba y producción se mantienen separadas. Para guardarlas se requieren nombre y apellido, teléfono, dirección y ciudad. Datos de facturación guardados no equivalen a emisión de comprobantes tributarios.
- **Pago con tarjeta (Culqi):** ver la sección siguiente.
- **Planes:** `plans` en `config.php` (id, nombre, días, equipos, descripción); el precio sale del tramo vigente. `payment_instructions` es el texto que ve el cliente tras pedir.
- La clave de las licencias **compradas** se guarda cifrada (AES-256-GCM) para que su dueño la vea en el portal; las creadas desde el panel solo muestran la clave una vez.
- La landing se recompila con `cd landing && npm install && npm run build`, copiando `landing/dist` a `site/` (se versiona para no necesitar Node en el servidor). El formulario "Solicitar demo" guarda el correo como evento visible en *Actividad*.
- Tras actualizar el código, `bash php/install.sh <app>` también migra la base de datos (`app/bin/setup.php --migrate`). Con MySQL no hace falta ninguna otra acción.

> La versión Cloudflare Worker (`src/`) solo cubre la API del complemento y el panel básico; el portal, los pedidos y las licencias por minutos están únicamente en la versión PHP.

## Cobro con tarjeta (Culqi)
1. En el panel de Culqi (**Desarrollo → API Keys**) copia la llave pública (`pk_…`) y la privada (`sk_…`). **Empieza con las de PRUEBA** (`pk_test_`/`sk_test_`).
2. Por SSH: `php app/bin/setup.php --setup-culqi` (la privada se teclea oculta y nunca se muestra ni se guarda en el repositorio) y luego `php app/bin/setup.php --payment-mode=culqi`.
3. Prueba una compra con las tarjetas de prueba que publica Culqi. Cuando todo funcione, repite el paso 2 con las llaves reales (`pk_live_`/`sk_live_`).

Cómo funciona: el navegador abre el formulario de Culqi con la llave **pública** y recibe un token; el servidor crea el cargo con la llave **privada** (`POST /v2/charges`, importe en céntimos de sol). Garantías:
- El **monto y la moneda salen siempre del pedido guardado**, nunca del navegador.
- Un pedido **no se puede cobrar dos veces**: se reserva de forma atómica (dos clics o dos pestañas no duplican el cobro).
- Tarjeta rechazada → el pedido sigue pendiente y se puede reintentar. **Si la conexión se corta sin respuesta clara**, el pedido queda en **"Verificando pago"** y no se vuelve a cobrar: el administrador lo comprueba en Culqi y lo aprueba (o cancela) desde *Pedidos*.
- Máximo 5 intentos de pago por pedido y hora. La llave privada nunca sale en ninguna respuesta.

> **Validación de Culqi:** flujo contrastado con su SDK PHP oficial y documentación de tarjetas. Pruebas locales con Culqi simulado; falta validación contra el entorno real de integración del comercio. No incluye **3D Secure** ni **Yape**. El formulario usa Culqi Checkout v4 (`checkout.culqi.com/js/v4`). La primera prueba con el proveedor debe hacerse con llaves de prueba.

Prueba aislada del panel, pagos, cuota diaria y separación de cuentas: `PHP=/ruta/php EXTRA_SUITES=1 node test/dashboard-integration.mjs`. Crea configuración y SQLite temporales; no usa datos reales. Incluye las suites de Culqi, correo, API de licencias y SMTP. `php php/tests/tiers_test.php` comprueba el catálogo fijo sin abrir una base de datos.

## Correo: verificar cuentas, recuperar contraseña y avisos
Con el correo configurado el servidor:
- **Exige confirmar el correo** antes de activar la prueba gratis o comprar (se acabaron las cuentas con correos falsos). Quien restablece su contraseña por correo también queda verificado.
- Envía **"Olvidé mi contraseña"** (enlace de 1 hora, un solo uso, cierra las demás sesiones y avisa del cambio), **"Recibimos tu pedido"**, **"Tu licencia está lista"** al cliente y un **aviso de pedido por aprobar al administrador**.
- Sin correo configurado todo sigue funcionando como antes (sin verificación ni recuperación).

Configuración (por SSH, una vez; sirve cualquier proveedor SMTP):
```bash
cd ~/applications/<app>/public_html
php app/bin/setup.php --public-url=https://bimflow.midominio.com   # URL que llevan los enlaces (obligatoria)
php app/bin/setup.php --setup-mail                                 # servidor, puerto, usuario, contraseña y remitente
php app/bin/setup.php --admin-email=tu@correo.com                  # a quién avisar de pedidos por aprobar
php app/bin/setup.php --test-mail=tu@correo.com                    # correo de prueba
```
Proveedores: **Brevo** (gratis 300/día; `smtp-relay.brevo.com`, 587, `tls`), **Gmail/Google Workspace** con contraseña de aplicación (`smtp.gmail.com`, 587, `tls`, ~500/día) o el complemento de correo de Cloudways. Para que no caigan en spam, usa un remitente de tu dominio y configura SPF/DKIM según indique el proveedor. **`public_url` es obligatoria**: los enlaces nunca se arman con el encabezado Host de la petición (permitiría desviar los enlaces de recuperación a otro sitio).

Pruebas: `test/e2e-mail.mjs` (44 comprobaciones, correo en modo `log`) y `test/smtp-test.mjs` (protocolo SMTP contra un servidor simulado; no cubre STARTTLS/SSL reales: usa `--test-mail` con tu proveedor).

## Panel de administración: usuarios y acceso con Google

- **Usuarios** (`/admin/` → Usuarios): crear, editar, eliminar y gestionar cuentas.
  - **Nuevo usuario**: por invitación (le llega un correo para que elija su contraseña, vale 48 h) o con una contraseña que tú defines. Requiere correo configurado solo para la invitación.
  - **Ficha del usuario**: datos de contacto, correo verificado sí/no, enviar enlace de contraseña (vale 6 h), definir contraseña, cerrar sesiones, licencias vinculadas.
  - **Eliminar**: pide escribir el correo de la cuenta. Las licencias de pago se **conservan** (quedan sin cuenta) o se **eliminan** con ella, a elección; la licencia gratuita siempre se elimina con la cuenta. Los pedidos pendientes se cancelan y se bloquea si hay un pago en verificación. Las huellas de equipo de la prueba se conservan para que borrar y volver a registrarse no reinicie la prueba.
- **Google para el administrador**: con `--setup-google` configurado, el botón *Continuar con Google* aparece en el ingreso y en el registro del portal. Si el correo verificado por Google coincide con el correo de acceso del administrador (`--admin-login-email=`), abre directamente `/admin/`. Cualquier otro correo entra como cliente. Microsoft nunca concede acceso de administrador. La contraseña de administrador sigue funcionando como respaldo.

## Instalador para clientes
En el panel de administración, **Resumen → Instalador para clientes → Publicar instalador**: sube el `.exe` que descargas de GitHub Actions. Queda en `/downloads/Xport_Setup.exe` con su versión y su **huella SHA-256**, y aparece en el portal y en `/instalacion/`, la guía amable con los pasos para cada aviso de Windows (SmartScreen, Control inteligente de aplicaciones, navegador, antivirus, Revit).

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
