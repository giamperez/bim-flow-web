# Registro con Google y Microsoft

La integración usa OpenID Connect con código de autorización, PKCE y nonce. Los botones aparecen en **Crear cuenta** cuando el proveedor tiene ID y secreto configurados. El registro con correo siempre está disponible. No se solicita acceso a archivos ni contactos, ni se guardan tokens de acceso o de refresco.

## Google

1. Crea un proyecto y configura la marca y la pantalla de consentimiento en [Google Cloud Console](https://console.cloud.google.com/). Configura Xport como nombre y `contacto@vertexdev.tech` como contacto público.
2. Crea un cliente OAuth de tipo **Aplicación web**.
3. Añade esta URI de redirección autorizada, exactamente:

   ```text
   https://bimflow.vertexdev.tech/portal/api/oauth/google/callback
   ```

4. Configura las URLs públicas de los documentos:

   ```text
   https://bimflow.vertexdev.tech/legal/terminos/
   https://bimflow.vertexdev.tech/legal/privacidad/
   ```

5. Si la aplicación está limitada a usuarios de prueba, añade la cuenta con la que comprobarás el acceso. La disponibilidad pública depende del estado y las restricciones de la aplicación en Google.
6. En el servidor, ejecuta:

   ```bash
   cd ~/applications/wqdgpxdvnh/public_html
   php app/bin/setup.php --setup-google
   ```

   Introduce el ID de cliente y el secreto. El secreto se escribe oculto en la terminal SSH de Linux y permanece en `config.php`, fuera del repositorio.

Referencia oficial: [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect).

## Microsoft

1. Crea un registro de aplicación en [Microsoft Entra](https://entra.microsoft.com/).
2. Para aceptar cuentas personales y de trabajo, selecciona cuentas de cualquier directorio organizativo y cuentas personales de Microsoft. El asistente de Xport utiliza `common` como tenant para ese caso. Si restringes el directorio, introduce su ID en el asistente.
3. Añade una plataforma de tipo **Web** con esta URI exacta:

   ```text
   https://bimflow.vertexdev.tech/portal/api/oauth/microsoft/callback
   ```

4. Crea un secreto de cliente. Usa su **valor**, no el identificador del secreto, junto con el Application (client) ID.
5. En el servidor:

   ```bash
   cd ~/applications/wqdgpxdvnh/public_html
   php app/bin/setup.php --setup-microsoft
   ```

6. Introduce ID, valor del secreto y tenant. Anota la fecha de caducidad del secreto en el control operativo del servicio; vuelve a ejecutar el asistente cuando lo renueves.

Referencias oficiales: [registro de una aplicación](https://github.com/MicrosoftDocs/entra-docs/blob/main/docs/identity-platform/includes/registration/quickstart-register-app.md), [URI de redirección de una aplicación web](https://learn.microsoft.com/entra/identity-platform/how-to-add-redirect-uri), [tipos de cuenta y autoridad](https://learn.microsoft.com/en-us/entra/identity-platform/msal-client-application-configuration).

## Comprobación

Después de instalar o actualizar con `php/install.sh`, abre `/portal/`, pulsa **Crear cuenta gratis** y prueba cada proveedor configurado con una cuenta de prueba nueva. Debe volver al portal, conservar la cuenta en posteriores accesos y permitir editar los datos en el perfil. Comprueba también la cancelación del acceso en el proveedor.

- Si ya existe una cuenta local con ese correo, Xport solicita ingresar con su contraseña. No vincula cuentas por una coincidencia de correo.
- Un registro SSO no da acceso de administrador, aunque coincida con su correo. El administrador conserva el acceso con su correo configurado y contraseña de administración.
- Google debe entregar un correo verificado. Microsoft no se considera prueba de control del correo; si la verificación por email está habilitada en Xport, se enviará la confirmación local.
- Un proveedor que no entregue un correo válido devuelve al formulario con una explicación y la opción de registrarse por correo.
- El registro crea el acceso Gratuito. La prueba Full de 14 días se activa desde el portal según elegibilidad.

Los documentos legales incluidos describen el funcionamiento implementado y el contacto proporcionado. Antes de presentarlos como documentos legales definitivos, el responsable del servicio debe completar su razón social y domicilio, y revisar los plazos y obligaciones que le correspondan. No se ha inventado un RUC, una inscripción de banco de datos o una dirección fiscal.
