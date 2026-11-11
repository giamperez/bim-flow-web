# Xport por BimFlow

## Catálogo vigente

| Computadoras por licencia | Mensual (30 días) | Anual (365 días) |
|---|---:|---:|
| 1 · Individual | S/ 19.90 | S/ 159.00 |
| 3 · Equipo | S/ 49.90 | S/ 399.00 |
| 7 · Estudio | S/ 99.90 | S/ 799.00 |

Los planes de pago incluyen Xport Full: seis formatos, perfiles y todos los ajustes. Se paga el período completo que el cliente confirma. Guardar una tarjeta no crea una suscripción ni cobros automáticos. Renovar el mismo plan suma su duración al vencimiento; cambiar de plan inicia un período nuevo. Reducir la capacidad libera los equipos menos recientes.

## Gratuito

Una computadora y 150 archivos principales por mes calendario de Perú, sin vencimiento comercial. PDF y DWG; selección de vistas/láminas, carpeta, nombres, color de PDF y PDF combinado. Conserva las herramientas de entrega (ZIP, reportes y organización de archivos). No permite perfiles, imágenes, DXF ni los ajustes avanzados de papel, raster, detalle y CAD.

Cada PDF individual o DWG principal consume una unidad. Un PDF combinado consume una. ZIP, reportes y archivos auxiliares no consumen unidades. El plugin reserva el número de archivos previstos antes de iniciar el lote; al finalizar concilia el número realmente publicado y devuelve el resto. Los reintentos del mismo lote reutilizan esa reserva.

El contador se controla por licencia y por computadora; cambiar de equipo o de clave no multiplica el cupo de la licencia. La renovación ocurre el primer día del mes a medianoche de Perú. Gratuito requiere internet. Las respuestas de reserva perdidas y conciliaciones fallidas se guardan localmente para reintentarlas; un cierre abrupto de Revit antes de informar el resultado puede dejar el cupo reservado para revisión.

## Prueba Full

Se activa explícitamente desde la cuenta, dura 14 días en una computadora y no requiere tarjeta. Una por cuenta y por computadora. No consume el cupo mensual gratuito. Al terminar regresa a Gratuito con la misma clave y conserva el consumo gratuito que ya tuviera ese mes. Los planes de pago vencidos del portal también regresan a Gratuito, manteniendo una computadora; las licencias administrativas sin cliente conservan su vencimiento normal.

## Compatibilidad y migración

El plugin 3.3.0 verifica derechos firmados (`access`, `monthlyLimit`) y habilita las opciones correspondientes. Reserva en `POST /api/v1/export` (`requestId`, `units`, `requiresFull`) y concilia en `POST /api/v1/complete` (`requestId`, `units` realmente generadas). Los planes de pago y la prueba Full conservan la gracia sin conexión del token, dentro de su vencimiento; Gratuito siempre requiere una reserva en línea.

La migración agrega columnas y tablas, conserva configuración, claves de firma, Culqi, clientes y pedidos históricos. Las antiguas licencias gratuitas de 30 días/1 lote diario pasan a Gratuito/150 archivos mensuales. No cambia pedidos pagados. Los pendientes que ya no coinciden con el catálogo se conservan y no pueden pagarse con una tarifa vieja. Los overrides antiguos de `plans`, `pricing_tiers` y `price_lock` no modifican el catálogo vigente.

Instalar primero el servidor actualizado y publicar el instalador 3.3.0 desde Administración. Las versiones anteriores pueden seguir usando las licencias de pago; Gratuito y la prueba Full requieren 3.3.0.
