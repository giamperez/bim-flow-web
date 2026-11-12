import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const PORT = 8788;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// Mock data for Admin & Portal
let adminLoggedIn = true;
const mockLicenses = [
  { id: 'lic-1', customerName: 'Estudio Arquitectura BIM', customerEmail: 'contacto@estudiobim.pe', keyHint: '84B9A', state: 'active', expiresAt: Math.floor(Date.now() / 1000) + 180 * 86400, devicesActive: 2, maxDevices: 3, lastSeen: Math.floor(Date.now() / 1000) - 3600, plan: 'Equipo' },
  { id: 'lic-2', customerName: 'Constructora Lima Sur', customerEmail: 'proyectos@limasur.com', keyHint: '29CD1', state: 'expiring', expiresAt: Math.floor(Date.now() / 1000) + 12 * 86400, devicesActive: 1, maxDevices: 1, lastSeen: Math.floor(Date.now() / 1000) - 7200, plan: 'Individual' },
  { id: 'lic-3', customerName: 'Vértice Consultores', customerEmail: 'bim@vertice.com', keyHint: '77F12', state: 'active', expiresAt: Math.floor(Date.now() / 1000) + 320 * 86400, devicesActive: 5, maxDevices: 7, lastSeen: Math.floor(Date.now() / 1000) - 1800, plan: 'Estudio' },
  { id: 'lic-4', customerName: 'Arq. Carlos Mendoza', customerEmail: 'carlos@mendoza.pe', keyHint: '110A9', state: 'expired', expiresAt: Math.floor(Date.now() / 1000) - 10 * 86400, devicesActive: 0, maxDevices: 1, lastSeen: Math.floor(Date.now() / 1000) - 86400 * 15, plan: 'Individual' },
];

const mockOrders = [
  { id: 'ord-101', code: 'BF-882910', customerName: 'Constructora Lima Sur', customerEmail: 'proyectos@limasur.com', planName: 'Renovación Anual - Individual', amountCents: 15900, currency: 'PEN', kind: 'renew', status: 'pending', createdAt: Math.floor(Date.now() / 1000) - 3600, licenseId: 'lic-2' },
  { id: 'ord-102', code: 'BF-990211', customerName: 'Grupo Ingenieros SAC', customerEmail: 'admin@grupoing.pe', planName: 'Plan Equipo - 3 Computadoras', amountCents: 4990, currency: 'PEN', kind: 'new', status: 'processing', providerRef: 'culqi_ch_test_9921', createdAt: Math.floor(Date.now() / 1000) - 1200 },
  { id: 'ord-100', code: 'BF-771822', customerName: 'Vértice Consultores', customerEmail: 'bim@vertice.com', planName: 'Plan Estudio - Anual', amountCents: 79900, currency: 'PEN', kind: 'new', status: 'paid', createdAt: Math.floor(Date.now() / 1000) - 86400 * 5, licenseId: 'lic-3' },
];

const mockEvents = [
  { created_at: Math.floor(Date.now() / 1000) - 1200, type: 'payment_attempt', customer_name: 'Grupo Ingenieros SAC', detail: 'Cargo por S/ 49.90 en verificación', ip: '190.237.40.12' },
  { created_at: Math.floor(Date.now() / 1000) - 3600, type: 'order_created', customer_name: 'Constructora Lima Sur', detail: 'Pedido BF-882910 creado', ip: '200.48.80.19' },
  { created_at: Math.floor(Date.now() / 1000) - 7200, type: 'activated', customer_name: 'Estudio Arquitectura BIM', detail: 'Equipo Dell Precision 5820 activado (Revit 2026)', ip: '179.6.14.88' },
  { created_at: Math.floor(Date.now() / 1000) - 86400, type: 'installer_uploaded', customer_name: null, detail: 'Xport_Setup_v3.3.0.exe publicado', ip: '127.0.0.1' },
];

let mockCustomerLicense = {
  id: 'lic-10',
  plan: 'Equipo',
  state: 'active',
  isTrial: false,
  accessMode: 'paid',
  maxDevices: 3,
  expiresAt: Math.floor(Date.now() / 1000) + 240 * 86400,
  secondsLeft: 240 * 86400,
  monthlyLimit: 0,
  exportsUsed: 38,
  usageResetsAt: Math.floor(Date.now() / 1000) + 19 * 86400,
  key: 'XPBM-99214-AA821-B8821-99201',
  devices: [
    { id: 'dev_1', name: 'Workstation Principal (BIM)', revitVersion: '2026', appVersion: '3.3.0', status: 'active', lastSeen: Math.floor(Date.now() / 1000) - 1800 },
    { id: 'dev_2', name: 'Laptop Modelado Laptop-GP', revitVersion: '2025', appVersion: '3.3.0', status: 'active', lastSeen: Math.floor(Date.now() / 1000) - 86400 * 2 },
  ],
};

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

// In-memory fixtures for visual previews only. Real API behavior is tested with PHP + SQLite.
const mockCustomers = mockLicenses.map((l, i) => ({ id: 'customer-' + i, name: l.customerName,
  email: l.customerEmail, company: l.customerName, phone: '', verified: i !== 1,
  createdAt: Math.floor(Date.now() / 1000) - (i + 1) * 86400, licensesCount: 1 }));
mockLicenses.forEach((l, i) => { l.customerId = mockCustomers[i].id; });
async function previewBody(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 65536) return {}; }
  try { return JSON.parse(body || '{}'); } catch { return {}; }
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Admin APIs
  if (pathname.startsWith('/admin/api')) {
    const sub = pathname.replace('/admin/api', '');
    if (sub === '/me') {
      return adminLoggedIn ? sendJson(res, 200, { ok: true, admin: true }) : sendJson(res, 401, { ok: false, error: 'unauthorized' });
    }
    if (sub === '/login') {
      adminLoggedIn = true;
      return sendJson(res, 200, { ok: true });
    }
    if (sub === '/logout') {
      adminLoggedIn = false;
      return sendJson(res, 200, { ok: true });
    }
    if (sub === '/stats') {
      return sendJson(res, 200, {
        ok: true,
        licenses: { active: 14, expiring: 2, expired: 1, blocked: 0 },
        devicesActive: 22,
        customersTotal: mockCustomers.length,
        pendingOrders: 2,
        suspiciousLast7d: 0,
        nextToExpire: mockLicenses.slice(0, 3),
      });
    }
    if (sub === '/customers') {
      const q=(url.searchParams.get('q')||'').toLowerCase(), page=Math.max(0,Number(url.searchParams.get('page'))||0);
      const rows=mockCustomers.filter(c=>[c.name,c.email,c.company].some(v=>v.toLowerCase().includes(q)));
      return sendJson(res,200,{ok:true,customers:rows.slice(page*25,page*25+25),hasMore:rows.length>(page+1)*25});
    }
    if (sub.startsWith('/customers/')) {
      const [, , id, action]=sub.split('/'), customer=mockCustomers.find(c=>c.id===id);
      if(!customer)return sendJson(res,404,{ok:false,error:'Usuario no encontrado.'});
      if(req.method==='PATCH') {
        const body=await previewBody(req);
        for(const field of ['name','email','company','phone'])if(typeof body[field]==='string')customer[field]=body[field];
        return sendJson(res,200,{ok:true});
      }
      if(action==='revoke-sessions')return sendJson(res,200,{ok:true});
      return sendJson(res,200,{ok:true,customer,licenses:mockLicenses.filter(l=>l.customerId===id),ordersCount:0,paidOrders:0});
    }
    if (sub === '/licenses' && req.method === 'POST') {
      const body=await previewBody(req), c=mockCustomers.find(c=>c.id===body.customerId);
      const license={id:'preview-'+Date.now(),customerId:c?.id,customerName:c?.name||body.customerName,
        customerEmail:c?.email||body.customerEmail,plan:body.plan,maxDevices:Number(body.maxDevices),devicesActive:0,
        state:'active',status:'active',expiresAt:body.expiresAt||Math.floor(Date.now()/1000)+Number(body.minutes)*60,
        createdAt:Math.floor(Date.now()/1000),keyHint:'DEMO1',notes:body.notes||''};
      mockLicenses.unshift(license); if(c)c.licensesCount++;
      return sendJson(res,201,{ok:true,license,key:'XPBM-DEMO1-DEMO1-DEMO1-DEMO1'});
    }
    if (sub.startsWith('/licenses/') && req.method === 'GET') {
      const license=mockLicenses.find(l=>l.id===sub.split('/')[2]);
      return license?sendJson(res,200,{ok:true,license,devices:[],events:[]}):sendJson(res,404,{ok:false,error:'No encontrada.'});
    }
    if (sub === '/licenses') {
      return sendJson(res, 200, { ok: true, licenses: mockLicenses, hasMore: false });
    }
    if (sub === '/orders') {
      return sendJson(res, 200, { ok: true, orders: mockOrders, hasMore: false });
    }
    if (sub === '/events') {
      return sendJson(res, 200, { ok: true, events: mockEvents, hasMore: false });
    }
    if (sub === '/installer') {
      return sendJson(res, 200, {
        ok: true,
        installer: {
          version: '3.3.0',
          size: 47185920,
          uploadedAt: Math.floor(Date.now() / 1000) - 86400,
          sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
          url: '/downloads/Xport_Setup.exe',
        },
      });
    }
  }

  // Portal APIs
  if (pathname.startsWith('/portal/api')) {
    const sub = pathname.replace('/portal/api', '');
    if (sub === '/me') {
      return sendJson(res, 200, {
        ok: true,
        customer: { id: 'cust_01', name: 'Gianfranco Perez', email: 'gian@bimflow.pe', company: 'BimFlow Studio', phone: '+51 987 654 321', verified: true },
        verificationRequired: false,
      });
    }
    if (sub === '/license') {
      return sendJson(res, 200, {
        ok: true,
        license: mockCustomerLicense,
      });
    }
    if (sub === '/download') {
      return sendJson(res, 200, {
        ok: true,
        installer: {
          version: '3.3.0',
          size: 47185920,
          sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
          uploadedAt: Math.floor(Date.now() / 1000) - 86400,
          url: '/downloads/Xport_Setup.exe',
        },
      });
    }
    if (sub === '/plans') {
      return sendJson(res, 200, {
        ok: true,
        paymentMode: 'manual',
        plans: [
          { id: 'gratis', name: 'Gratuito', displayName: 'Gratuito', free: true, cycle: 'free', seconds: 0, devices: 1, priceCents: 0, currency: 'PEN', monthlyLimit: 150, description: 'PDF y DWG con los ajustes esenciales.' },
          { id: 'mensual', name: 'Individual', displayName: 'Individual', free: false, cycle: 'monthly', seconds: 30 * 86400, devices: 1, priceCents: 1990, currency: 'PEN', monthlyLimit: 0, description: 'Todas las opciones. Todos los formatos.' },
          { id: 'anual', name: 'Individual', displayName: 'Individual', free: false, cycle: 'annual', seconds: 365 * 86400, devices: 1, priceCents: 15900, currency: 'PEN', monthlyLimit: 0, description: 'Todas las opciones. Todos los formatos.' },
          { id: 'equipo', name: 'Equipo', displayName: 'Equipo', free: false, cycle: 'monthly', seconds: 30 * 86400, devices: 3, priceCents: 4990, currency: 'PEN', monthlyLimit: 0, description: 'Todas las opciones. Todos los formatos.' },
          { id: 'equipo_anual', name: 'Equipo', displayName: 'Equipo', free: false, cycle: 'annual', seconds: 365 * 86400, devices: 3, priceCents: 39900, currency: 'PEN', monthlyLimit: 0, description: 'Todas las opciones. Todos los formatos.' },
          { id: 'estudio', name: 'Estudio', displayName: 'Estudio', free: false, cycle: 'monthly', seconds: 30 * 86400, devices: 7, priceCents: 9990, currency: 'PEN', monthlyLimit: 0, description: 'Todas las opciones. Todos los formatos.' },
          { id: 'estudio_anual', name: 'Estudio', displayName: 'Estudio', free: false, cycle: 'annual', seconds: 365 * 86400, devices: 7, priceCents: 79900, currency: 'PEN', monthlyLimit: 0, description: 'Todas las opciones. Todos los formatos.' },
        ],
      });
    }
    if (sub === '/orders') {
      return sendJson(res, 200, {
        ok: true,
        orders: [
          { id: 'ord-100', code: 'BF-771822', planName: 'Plan Equipo - Anual', amountCents: 39900, currency: 'PEN', status: 'paid', createdAt: Math.floor(Date.now() / 1000) - 86400 * 30 },
        ],
      });
    }
    if (sub === '/cards') {
      return sendJson(res, 200, {
        ok: true,
        cards: [
          { id: 'crd_1', brand: 'Visa', lastFour: '4242', last_four: '4242' },
        ],
      });
    }
    if (sub === '/billing') {
      return sendJson(res, 200, {
        ok: true,
        billing: { name: 'BimFlow Studio SAC', docType: 'RUC', docNumber: '20601234567', address: 'Av. Javier Prado Este 440', city: 'Lima', country: 'PE' },
      });
    }
    if (sub === '/license/regenerate-key') {
      mockCustomerLicense.key = 'XPBM-55443-BB991-C2233-88771';
      return sendJson(res, 200, { ok: true, key: mockCustomerLicense.key });
    }
    if (sub?.startsWith('/license/devices/') && sub?.endsWith('/release')) {
      const parts = sub.split('/');
      const devId = parts[3];
      mockCustomerLicense.devices = mockCustomerLicense.devices.map(d => d.id === devId ? { ...d, status: 'released' } : d);
      return sendJson(res, 200, { ok: true });
    }
    if (sub === '/trial') {
      mockCustomerLicense.isTrial = true;
      mockCustomerLicense.accessMode = 'trial';
      mockCustomerLicense.plan = 'Prueba Full · 14 días';
      return sendJson(res, 200, { ok: true });
    }
    if (sub === '/profile') {
      return sendJson(res, 200, { ok: true });
    }
    if (sub === '/lead') {
      return sendJson(res, 200, { ok: true });
    }
  }

  // Static File Resolution
  const roots = [
    path.join(ROOT, 'site'),
    path.join(ROOT, 'public'),
    path.join(ROOT, 'landing', 'public'),
  ];

  let relPath = pathname.replace(/^\/+/, '');
  if (relPath === '' || relPath.endsWith('/')) {
    relPath += 'index.html';
  }

  for (const root of roots) {
    const filePath = path.join(root, relPath);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found: ' + pathname);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`BimFlow Local Dev/Test Server running at http://127.0.0.1:${PORT}`);
});
