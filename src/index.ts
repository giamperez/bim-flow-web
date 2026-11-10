import { Hono } from 'hono';
import { adminApi } from './admin-api';
import { licenseApi } from './license-api';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Cache-Control', 'no-store');
});

app.get('/api/v1/health', (c) => c.json({ ok: true }));
app.route('/api/v1', licenseApi);
app.route('/admin/api', adminApi);

app.onError((err, c) => {
  console.error(err);
  return c.json({ ok: false, error: 'server_error', message: 'Error interno del servidor.' }, 500);
});

app.notFound((c) => c.json({ ok: false, error: 'not_found' }, 404));

export default app;
