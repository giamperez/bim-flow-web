// PHP + SQLite aislados, Culqi simulado. No usa configuración, cuentas ni tarjetas reales.
// PHP=C:/ruta/php.exe node test/dashboard-integration.mjs
import {mkdtempSync,cpSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import http from 'node:http';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const PHP=process.env.PHP||'php', root=resolve(import.meta.dirname,'..');
const sandbox=mkdtempSync(join(tmpdir(),'bimflow-dashboard-'));
cpSync(join(root,'php'),join(sandbox,'php'),{recursive:true,filter:p=>!p.endsWith('config.php')&&!p.includes('node_modules')});
cpSync(join(root,'public'),join(sandbox,'public'),{recursive:true});
mkdirSync(join(sandbox,'site'),{recursive:true});
cpSync(join(root,'site/brand'),join(sandbox,'site/brand'),{recursive:true});
const password='qa-dashboard-only-1234';
const config={db:{driver:'sqlite',path:join(sandbox,'qa.sqlite')},session_secret:'isolated-integration-test-session-secret-12345',payment_mode:'culqi',payment_instructions:'Realice el pago indicando el codigo del pedido.',public_url:'http://127.0.0.1:8788',ip_header:'HTTP_X_FORWARDED_FOR',culqi:{public_key:'pk_test_FAKE123',secret_key:'sk_test_FAKEKEY123',api_base:'http://127.0.0.1:8799/v2'}};
const configPath=join(sandbox,'php/app/config.php');
const bootstrap=join(sandbox,'php/app/bootstrap.php');
function php(code){const r=spawnSync(PHP,['-r',code],{encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr||r.stdout);return r.stdout;}
const quote=s=>JSON.stringify(s.replaceAll('\\','/'));
php(`$c=json_decode(base64_decode('${Buffer.from(JSON.stringify(config)).toString('base64')}'),true);$key=openssl_pkey_new(['private_key_type'=>OPENSSL_KEYTYPE_EC,'curve_name'=>'prime256v1']);openssl_pkey_export($key,$pem);$c['signing_key_pem']=$pem;$c['admin_password_hash']=password_hash('${password}',PASSWORD_DEFAULT);file_put_contents(${quote(configPath)},'<?php return '.var_export($c,true).';');`);
// Empezar con el esquema anterior prueba ALTER TABLE, además de la instalación y repetición.
const oldSchema=readFileSync(join(root,'test/fixtures/customer-schema-v1.sql'),'utf8');
php(`$pdo=new PDO('sqlite:'.${quote(config.db.path)});$pdo->exec(base64_decode('${Buffer.from(oldSchema).toString('base64')}'));`);
const migration=spawnSync(PHP,[join(sandbox,'php/app/bin/setup.php'),'--migrate'],{encoding:'utf8'});
assert.equal(migration.status,0,migration.stdout+migration.stderr);
const migrate2=spawnSync(PHP,[join(sandbox,'php/app/bin/setup.php'),'--migrate'],{encoding:'utf8'});
assert.equal(migrate2.status,0,'Migration must be repeatable');
assert.equal(php(`require ${quote(bootstrap)};$r=xp_one("SELECT * FROM customers WHERE id = 'migration-fixture'");echo $r['name'].'|'.$r['phone'].'|'.$r['created_at'];`),'Cuenta anterior||123','Migration preserves existing account data');
assert.equal(php(`require ${quote(bootstrap)};$r=xp_one("SELECT * FROM licenses WHERE id = 'legacy-free'");echo $r['access_mode'].'|'.$r['expires_at'].'|'.$r['is_trial'];`),'free|253402300799|0','Old daily-free license migrates to monthly free without expiry');
assert.equal(php(`require ${quote(bootstrap)};$r=xp_one("SELECT * FROM licenses WHERE id = 'legacy-paid'");echo $r['access_mode'].'|'.$r['plan'].'|'.$r['max_devices'].'|'.$r['expires_at'];`),'paid|Anual|2|4102444800','Paid historical annual license remains unchanged');
const charges=[], providerCards=new Map(); let seq=0;
const fake=http.createServer((req,res)=>{let raw='';req.on('data',d=>raw+=d);req.on('end',()=>{
  const body=raw?JSON.parse(raw):{};
  const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
  if(req.headers.authorization!=='Bearer sk_test_FAKEKEY123')return send(401,{object:'error'});
  if(req.url==='/v2/customers')return send(201,{object:'customer',id:'cus_test_qa1234'});
  if(req.url==='/v2/cards'&&req.method==='POST'){
    const id='crd_test_saved'+(++seq);providerCards.set(id,true);
    return send(201,{object:'card',id,source:{last_four:'1111',iin:{card_brand:'Visa'}}});
  }
  if(req.url.startsWith('/v2/cards/')&&req.method==='DELETE'){providerCards.delete(req.url.split('/').pop());return send(200,{deleted:true});}
  if(req.url==='/v2/charges'){
    charges.push(body);
    if(body.source_id==='tkn_test_declined')return send(400,{object:'error',user_message:'Tarjeta rechazada.'});
    if(body.source_id==='tkn_test_unknown')return send(201,{object:'charge',id:'chr_test_unknown',outcome:{type:'pendiente'}});
    if(body.source_id==='tkn_test_servererror')return send(500,{object:'error'});
    return send(201,{object:'charge',id:'chr_test_'+(++seq),outcome:{type:'venta_exitosa'}});
  }
  send(404,{object:'error'});
});});
await new Promise(r=>fake.listen(8799,'127.0.0.1',r));
const server=spawn(PHP,['-d','opcache.enable=0','-d','opcache.enable_cli=0','-S','127.0.0.1:8788','-t',join(sandbox,'php/public'),join(sandbox,'php/dev-router.php')],{stdio:['ignore','pipe','pipe']});
let logs='';server.stderr.on('data',d=>logs+=d);
const base='http://127.0.0.1:8788', jar={};let count=0;
function check(name,ok){assert(ok,name);count++;console.log('✓ '+name);}
async function call(who,path,method='GET',body,csrf=true){
  const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(csrf?{'X-Requested-With':'bimflow'}:{}),...(jar[who]?{Cookie:jar[who]}:{}),'X-Forwarded-For':'10.7.1.1'},body:body===undefined?undefined:JSON.stringify(body)});
  const cookie=res.headers.get('set-cookie');if(cookie)jar[who]=cookie.split(';')[0];
  const data=await res.json().catch(()=>null);return {status:res.status,data};
}
const por=(w,p,m,b,c)=>call(w,'/portal/api'+p,m,b,c);
const admin=(p,m,b)=>call('admin','/admin/api'+p,m,b);
const dev=(key,n=1)=>({key,deviceId:n.toString(16).padStart(64,'0'),deviceName:'PC-'+n,appVersion:'3.3.0',revitVersion:'2025',units:1,requiresFull:false});
const api=(p,b)=>call('none','/api/v1/'+p,'POST',b);
const sql=code=>php(`require ${quote(bootstrap)};${code}`);
try{
  for(let i=0;i<40;i++){try{await fetch(base+'/api/v1/health');break;}catch{await new Promise(r=>setTimeout(r,100));}}
  check('Admin login separado del cliente',(await admin('/login','POST',{password})).status===200);
  const catalog=(await por('none','/plans')).data;
  check('Catálogo mensual y anual, sin tramos',catalog.tier===null&&catalog.plans.length===7&&catalog.plans.map(p=>p.priceCents).join(',')==='0,1990,15900,4990,39900,9990,79900'&&catalog.plans.map(p=>p.devices).join(',')==='1,1,1,3,3,7,7');
  check('Gratuito permanente con 150 archivos al mes',catalog.plans[0].seconds===0&&catalog.plans[0].monthlyLimit===150&&catalog.plans[0].free);
  check('Sin sesión no hay perfil',(await por('none','/me')).status===401);
  check('Rechaza correo temporal',(await por('a','/register','POST',{name:'Test',email:'x@mailinator.com',password})).status===400);
  check('Registro',(await por('a','/register','POST',{name:'Ana Diseño',email:'ana@example.test',password})).status===201);
  check('Cuenta no entra al administrador',(await call('a','/admin/api/stats')).status===401);
  check('CSRF en perfil',(await por('a','/profile','PATCH',{name:'X'},false)).status===403);
  const free=(await por('a','/license')).data.license;
  check('Licencia gratuita automática',free.accessMode==='free'&&!free.isTrial&&free.maxDevices===1&&free.monthlyLimit===150&&free.secondsLeft>365*86400);
  check('Licencia automática idempotente',(await por('a','/license')).data.license.id===free.id);
  check('No permite reactivar el mes gratis',(await por('a','/orders','POST',{planId:'gratis'})).status===409);
  const obsolete=await api('activate',{...dev(free.key),appVersion:'3.1.0'});
  check('Plugin antiguo debe actualizar e invalida token anterior',obsolete.data.reason==='update_required'&&obsolete.data.error==='expired');
  const activation=await api('activate',dev(free.key));
  check('Activa plugin nuevo',activation.status===200);
  const payload=JSON.parse(Buffer.from(activation.data.token.split('.')[0],'base64url'));
  check('Token firmado contiene límite diario',payload.monthlyLimit===150&&payload.access==='free');
  check('No autoriza un equipo ajeno',(await api('export',{...dev(free.key,2),requestId:randomUUID()})).data.error==='device_not_activated');
  const requestId=randomUUID();
  check('Primera exportación diaria',(await api('export',{...dev(free.key),requestId})).status===200);
  check('Misma reserva idempotente',(await api('export',{...dev(free.key),requestId})).status===200);
  check('Reserva superior al saldo bloqueada',(await api('export',{...dev(free.key),requestId:randomUUID(),units:150})).data.error==='monthly_limit');
  check('Portal refleja consumo',(await por('a','/license')).data.license.exportsUsed===1);
  check('Fallido no consume archivo',(await api('complete',{...dev(free.key),requestId,units:0})).status===200);
  check('Reconciliación idempotente',(await api('complete',{...dev(free.key),requestId,units:0})).status===200);
  check('Saldo devuelto',(await por('a','/license')).data.license.exportsUsed===0);
  const largeRequest=randomUUID();
  check('Reserva lote de 150 archivos',(await api('export',{...dev(free.key),requestId:largeRequest,units:150})).status===200);
  check('Bloquea archivo 151',(await api('export',{...dev(free.key),requestId:randomUUID()})).data.error==='monthly_limit');
  check('Solo 149 generados devuelven un cupo',(await api('complete',{...dev(free.key),requestId:largeRequest,units:149})).status===200&&(await por('a','/license')).data.license.exportsUsed===149);
  check('No concilia dos resultados distintos',(await api('complete',{...dev(free.key),requestId:largeRequest,units:0})).status===409);
  sql("xp_exec(\"UPDATE export_buckets SET period = '2000-01'\");");
  check('Se renueva al mes siguiente',(await api('export',{...dev(free.key),requestId:randomUUID()})).status===200);
  check('Opciones avanzadas bloqueadas en Gratuito',(await api('export',{...dev(free.key),requestId:randomUUID(),requiresFull:true})).data.error==='full_required');
  check('Activa prueba Full de 14 días',(await por('a','/trial','POST')).status===200);
  const trial=(await por('a','/license')).data.license;
  check('Full 14 días conserva clave',trial.accessMode==='trial'&&trial.isTrial&&trial.monthlyLimit===0&&trial.key===free.key&&trial.secondsLeft<=14*86400&&trial.secondsLeft>13*86400);
  check('Full no tiene cupo ni restricción de opciones',(await api('export',{...dev(free.key),requestId:randomUUID(),units:500,requiresFull:true})).status===200);
  check('No repite prueba Full',(await por('a','/trial','POST')).status===409);
  sql("xp_exec(\"UPDATE licenses SET expires_at = 1 WHERE access_mode = 'trial'\");");
  const afterTrial=(await por('a','/license')).data.license;
  check('Prueba vencida vuelve a Gratuito con misma clave',afterTrial.accessMode==='free'&&!afterTrial.isTrial&&afterTrial.key===free.key&&afterTrial.monthlyLimit===150);
  check('Prueba vencida no habilita opciones Full',(await api('export',{...dev(free.key),requestId:randomUUID(),requiresFull:true})).data.error==='full_required');
  const freeDevice=free.key;
  check('Perfil valida teléfono',(await por('a','/profile','PATCH',{phone:'mal'})).status===400);
  check('Actualiza perfil',(await por('a','/profile','PATCH',{name:'Ana Arquitecta',company:'Estudio Norte',phone:'+51 999 888 777'})).status===200);
  const billing={name:'Estudio Norte',documentType:'RUC',documentNumber:'20123456789',address:'Av. Lima 123',city:'Lima',country:'PE'};
  check('Valida documento',(await por('a','/profile','PATCH',{billing:{...billing,documentNumber:'123'}})).status===400);
  check('Guarda facturación',(await por('a','/profile','PATCH',{billing})).status===200);
  const me=(await por('a','/me')).data.customer;
  check('Datos persistentes y sin hash',me.name==='Ana Arquitecta'&&me.company==='Estudio Norte'&&me.billing.documentNumber===billing.documentNumber&&!JSON.stringify(me).includes('password_hash'));
  check('Guardar tarjeta exige consentimiento',(await por('a','/cards','POST',{token:'tkn_test_save1234'})).status===400);
  check('No acepta PAN como token',(await por('a','/cards','POST',{token:'4111111111111111',consent:true})).status===400);
  check('No mezcla entornos de tarjetas',(await por('a','/cards','POST',{token:'tkn_live_save1234',consent:true})).status===400);
  check('Guarda referencia de Culqi',(await por('a','/cards','POST',{token:'tkn_test_save1234',consent:true})).status===201);
  const card=(await por('a','/cards')).data.cards[0];
  check('Solo marca y últimos cuatro dígitos',card.lastFour==='1111'&&card.brand==='Visa'&&!Object.hasOwn(card,'provider_id'));
  check('Otra cuenta registrada',(await por('b','/register','POST',{name:'Bruno Prueba',email:'bruno@example.test',password})).status===201);
  const otherFree=(await por('b','/license')).data.license;
  check('Otra cuenta puede solicitar una prueba sin equipo activo',(await por('b','/trial','POST')).status===200);
  check('Una computadora no repite prueba Full con otra cuenta',(await api('activate',dev(otherFree.key,1))).data.error==='trial_used');
  check('No lista tarjetas ajenas',(await por('b','/cards')).data.cards.length===0);
  check('No elimina tarjetas ajenas',(await por('b','/cards/'+card.id,'DELETE')).status===404);
  check('No cambia correo sin contraseña',(await por('a','/profile','PATCH',{email:'nueva@example.test'})).status===400);
  const oldOrder=(await por('a','/orders','POST',{planId:'mensual'})).data.order;
  sql(`xp_exec('UPDATE orders SET amount_cents = 2500 WHERE code = ?', ['${oldOrder.code}']);`);
  check('Tarifa antigua no disponible para cobrar',(await por('a','/orders/'+oldOrder.code+'/pay','POST',{cardId:card.id})).status===409);
  check('Historial conserva precio antiguo sin botón de pago',(await por('a','/orders')).data.orders.find(o=>o.code===oldOrder.code).canPay===false);
  await por('a','/orders/'+oldOrder.code+'/cancel','POST');
  const order=(await por('a','/orders','POST',{planId:'equipo',amount:1})).data;
  check('Precio procede del servidor',order.payment.amount===4990&&order.order.amountCents===4990);
  check('No paga con tarjeta ajena',(await por('b','/orders/'+order.order.code+'/pay','POST',{cardId:card.id})).status===404);
  const paid=await por('a','/orders/'+order.order.code+'/pay','POST',{cardId:card.id,amount:1});
  check('Paga con tarjeta propia',paid.status===200&&charges.at(-1).amount===4990&&charges.at(-1).source_id.startsWith('crd_test_'));
  check('Evita doble cobro',(await por('a','/orders/'+order.order.code+'/pay','POST',{cardId:card.id})).status===409);
  const team=(await por('a','/license')).data.license;
  check('Actualización de plan quita límite sin añadir días gratis',!team.isTrial&&team.maxDevices===3&&team.key===free.key&&team.secondsLeft<=30*86400);
  for(let n=2;n<=3;n++)check('Activa computadora '+n,(await api('activate',dev(team.key,n))).status===200);
  check('Respeta límite de equipos',(await api('activate',dev(team.key,4))).data.error==='device_limit');
  check('Plan pagado sin límite diario',(await api('export',{...dev(team.key),requestId:randomUUID()})).status===200);
  check('Plugin anterior mantiene compatibilidad para planes pagados',(await api('export',{...dev(team.key),appVersion:'3.2.0',units:undefined,requestId:randomUUID()})).status===200);
  const renew=(await por('a','/orders','POST',{planId:'equipo'})).data.order;
  await por('a','/orders/'+renew.code+'/pay','POST',{cardId:card.id});
  const renewed=(await por('a','/license')).data.license;
  check('Renovar mismo plan suma 30 días',renewed.expiresAt-team.expiresAt===30*86400);
  const downgrade=(await por('a','/orders','POST',{planId:'mensual'})).data.order;
  await por('a','/orders/'+downgrade.code+'/pay','POST',{cardId:card.id});
  const individual=(await por('a','/license')).data.license;
  check('Bajar plan reduce capacidad y libera excedentes',individual.maxDevices===1&&individual.devices.filter(d=>d.status==='active').length===1);
  const annual=(await por('a','/orders','POST',{planId:'equipo_anual'})).data.order;
  check('Anual de tres equipos cuesta S/ 399',annual.amountCents===39900&&annual.seconds===365*86400);
  await por('a','/orders/'+annual.code+'/pay','POST',{cardId:card.id});
  const annualLicense=(await por('a','/license')).data.license;
  check('Anual aplica 365 días y tres computadoras',annualLicense.maxDevices===3&&annualLicense.secondsLeft>364*86400&&annualLicense.secondsLeft<=365*86400);
  const annualRenew=(await por('a','/orders','POST',{planId:'equipo_anual'})).data.order;
  await por('a','/orders/'+annualRenew.code+'/pay','POST',{cardId:card.id});
  check('Renovación anual suma 365 días',(await por('a','/license')).data.license.expiresAt-annualLicense.expiresAt===365*86400);
  const decline=(await por('a','/orders','POST',{planId:'estudio'})).data.order;
  check('Rechazo permite reintentar',(await por('a','/orders/'+decline.code+'/pay','POST',{token:'tkn_test_declined'})).status===402);
  check('Pedido rechazado sigue pendiente',(await por('a','/orders')).data.orders.find(o=>o.code===decline.code).status==='pending');
  check('Usuario cancela pendiente',(await por('a','/orders/'+decline.code+'/cancel','POST')).status===200);
  const unknown=(await por('a','/orders','POST',{planId:'estudio'})).data.order;
  check('Respuesta incierta queda en verificación',(await por('a','/orders/'+unknown.code+'/pay','POST',{token:'tkn_test_unknown'})).status===502);
  const before=charges.length;
  check('Verificación no permite recobro',(await por('a','/orders/'+unknown.code+'/pay','POST',{cardId:card.id})).status===409&&charges.length===before);
  const review=(await admin('/orders?status=processing')).data.orders.find(o=>o.code===unknown.code);
  check('Admin ve cargo incierto',review.providerRef==='chr_test_unknown');
  check('Usuario no aprueba pagos',(await call('a','/admin/api/orders/'+review.id+'/approve','POST')).status===401);
  check('Admin puede conciliar',(await admin('/orders/'+review.id+'/approve','POST')).status===200);
  check('Conciliación aplica siete computadoras',(await por('a','/license')).data.license.maxDevices===7);
  sql(`xp_exec('UPDATE licenses SET expires_at = 1 WHERE id = ?', ['${free.id}']);`);
  const expiredPaid=(await por('a','/license')).data.license;
  check('Plan pagado vencido vuelve a Gratuito',expiredPaid.accessMode==='free'&&expiredPaid.maxDevices===1&&expiredPaid.key===free.key);
  check('Elimina tarjeta en Culqi y local',(await por('a','/cards/'+card.id,'DELETE')).status===200&&providerCards.size===0);
  const oldSession=jar.a;
  check('Contraseña actual requerida',(await por('a','/password','POST',{currentPassword:'incorrecta',password:'otra-clave-1234'})).status===400);
  check('Cambio de contraseña',(await por('a','/password','POST',{currentPassword:password,password:'otra-clave-1234'})).status===200);
  jar.old=oldSession;check('Otras sesiones invalidadas',(await por('old','/me')).status===401);
  check('Sesión actual sigue activa',(await por('a','/me')).status===200);
  check('Contraseña anterior ya no entra',(await por('z','/login','POST',{email:'ana@example.test',password})).status===401);
  check('Nueva contraseña entra',(await por('z','/login','POST',{email:'ana@example.test',password:'otra-clave-1234'})).status===200);
  check('Cambio de correo con contraseña',(await por('a','/profile','PATCH',{email:'nueva@example.test',currentPassword:'otra-clave-1234'})).status===200);
  check('Correo nuevo persiste',(await por('a','/me')).data.customer.email==='nueva@example.test');
  const owner=(await por('a','/me')).data.customer.id;
  sql(`xp_exec('DELETE FROM licenses WHERE customer_id = ?', ['${owner}']);`);
  check('Eliminar licencia no reinicia mes gratuito',(await por('a','/license')).data.license===null);
  check('Admin conserva acceso',(await admin('/stats')).status===200);
  const css=await fetch(base+'/portal/portal.css'); const cssText=await css.text();
  check('CSS del portal disponible',css.status===200&&cssText.includes('.sidebar'));
  const doc=await (await fetch(base+'/portal/')).text();
  check('HTML de panel con navegación y perfil',doc.includes('id="sidebar"')&&doc.includes('id="profileForm"')&&!doc.includes('sk_test_FAKEKEY123'));
  if(process.env.EXTRA_SUITES==='1'){
    await new Promise(r=>fake.close(r));
    const pub=JSON.parse(php(`$c=require ${quote(configPath)};$ec=openssl_pkey_get_details(openssl_pkey_get_private($c['signing_key_pem']))['ec'];echo json_encode(['x'=>base64_encode($ec['x']),'y'=>base64_encode($ec['y'])]);`));
    const env={...process.env,BASE_URL:base,ADMIN_PASSWORD:password,PUBLIC_KEY_X:pub.x,PUBLIC_KEY_Y:pub.y,PHP};
    const run=async(file,extra={})=>{
      const child=spawn(process.execPath,[file],{cwd:root,env:{...env,...extra},stdio:'inherit'});
      const code=await new Promise(r=>child.on('exit',r));assert.equal(code,0,'Regression suite: '+file);
    };
    await run(join(root,'test/e2e-culqi.mjs'));
    const log=join(sandbox,'mail.log');
    php(`$c=require ${quote(configPath)};$c['payment_mode']='manual';$c['mail']=['driver'=>'log','path'=>${quote(log)},'from_email'=>'noreply@example.test','from_name'=>'BIM FLOW'];$c['admin_email']='admin@example.test';file_put_contents(${quote(configPath)},'<?php return '.var_export($c,true).';');`);
    await run(join(root,'test/e2e-mail.mjs'),{MAIL_LOG:log});
    await run(join(root,'test/e2e.mjs'));
    // smtp-test espera ubicarse en test/ dentro de su proyecto aislado.
    mkdirSync(join(sandbox,'test'),{recursive:true});cpSync(join(root,'test/smtp-test.mjs'),join(sandbox,'test/smtp-test.mjs'));
    await run(join(sandbox,'test/smtp-test.mjs'));
  }
  if(process.env.KEEP_QA_SERVER==='1'){
    cpSync(join(root,'site'),join(sandbox,'site'),{recursive:true});
    php(`$c=require ${quote(configPath)};$c['payment_mode']='culqi';$c['mail']=['driver'=>'none'];file_put_contents(${quote(configPath)},'<?php return '.var_export($c,true).';');`);
    // Cuenta nueva para revisión visual en navegador; conserva el servidor hasta Ctrl+C.
    await por('visual','/register','POST',{name:'Giampier Perez',email:'visual@example.test',password});
    console.log('QA_READY '+JSON.stringify({sandbox,base,email:'visual@example.test',password}));
    await new Promise(resolve=>process.on('SIGINT',resolve));
  }
  console.log(`\n${count} comprobaciones correctas. Sandbox: ${sandbox}`);
}catch(e){console.error(e);console.error(logs.slice(-5000));process.exitCode=1;}
finally{server.kill();fake.close();}
