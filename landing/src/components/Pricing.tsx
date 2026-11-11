import { useEffect, useState } from 'react';
import { ArrowRight, Check } from 'lucide-react';

type Plan = { id: string; name: string; displayName?: string; free: boolean; cycle: string; seconds: number; devices: number; priceCents: number; currency: string; monthlyLimit: number; description: string };
const fallback: Plan[] = [
  {id:'gratis',name:'Gratuito',free:true,cycle:'free',seconds:0,devices:1,priceCents:0,currency:'PEN',monthlyLimit:150,description:'PDF y DWG con los ajustes esenciales.'},
  ...[['mensual','Individual',1,1990,15900],['equipo','Equipo',3,4990,39900],['estudio','Estudio',7,9990,79900]].flatMap(([id,name,devices,monthly,annual]) => ['monthly','annual'].map(cycle => ({
    id:cycle === 'monthly' ? String(id) : id === 'mensual' ? 'anual' : id+'_anual', name:String(name),displayName:String(name),free:false,cycle,seconds:(cycle==='monthly'?30:365)*86400,devices:Number(devices),priceCents:Number(cycle==='monthly'?monthly:annual),currency:'PEN',monthlyLimit:0,description:'Todas las opciones. Todos los formatos.'
  }))),
];
const money = (cents:number) => 'S/ ' + (cents/100).toFixed(2);

export function Pricing() {
  const [plans,setPlans] = useState<Plan[]>(fallback);
  const [cycle,setCycle] = useState('monthly');
  useEffect(() => {
    const controller = new AbortController();
    fetch('/portal/api/plans',{signal:controller.signal}).then(r=>r.ok?r.json():Promise.reject()).then(j=>{
      if (Array.isArray(j.plans) && j.plans.some((p:Plan)=>p.cycle==='annual')) setPlans(j.plans);
    }).catch(()=>{});
    return ()=>controller.abort();
  },[]);
  return <div>
    <div className="mb-10 flex justify-center">
      <div className="inline-flex gap-1 rounded-full border border-slate-200 bg-slate-100 p-1.5" role="group" aria-label="Período de facturación">
        {['monthly','annual'].map(value=><button key={value} type="button" onClick={()=>setCycle(value)} aria-pressed={cycle===value} className={`cursor-pointer rounded-full px-5 py-2.5 text-sm font-semibold transition-colors ${cycle===value?'bg-white text-brand shadow-sm':'text-slate-500 hover:text-brand'}`}>
          {value==='monthly'?'Mensual':'Anual'}{value==='annual'&&<span className="ml-2 text-[10px] font-bold text-teal-700">−33%</span>}
        </button>)}
      </div>
    </div>
    <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
      {plans.filter(p=>p.free||p.cycle===cycle).map(p=>{
        const best=p.devices===3;
        return <article key={p.id} className={`relative flex flex-col rounded-3xl border bg-white p-6 text-left ${best?'border-brand shadow-[0_25px_60px_-35px_rgba(0,91,174,0.5)]':'border-slate-200'}`}>
          {best&&<span className="absolute -top-3 left-6 rounded-full bg-brand px-3 py-1 text-[10px] font-bold tracking-wider text-white uppercase">Para tu equipo</span>}
          <p className="text-[10px] font-semibold tracking-wider text-slate-400 uppercase">{p.free?'Xport Gratuito':'Xport Full'}</p>
          <h3 className="mt-1 text-xl font-bold text-navy">{p.displayName||p.name}</h3>
          <div className="mt-5"><p className="text-[34px] leading-tight font-extrabold tracking-tight whitespace-nowrap text-navy">{p.free?'Gratis':money(p.priceCents)}</p><p className="mt-1 text-xs text-slate-500">{p.free?'para seguir creando':cycle==='annual'?'al año · pago único por 365 días':'al mes · pago único por 30 días'}</p></div>
          <p className="mt-5 min-h-10 text-sm text-slate-600">{p.description}</p>
          <ul className="my-6 grid gap-3 text-[13px] text-slate-600">
            {[`${p.devices} computadora${p.devices===1?'':'s'} por licencia`,p.free?'150 archivos al mes':'Archivos sin límite',p.free?'PDF y DWG':'PDF, DWG, DXF, PNG, JPG y TIFF',p.free?'Selección, color de PDF y PDF combinado':'Ajustes avanzados y perfiles reutilizables'].map(feature=><li className="flex items-start gap-2" key={feature}><Check className="mt-0.5 h-4 w-4 shrink-0 text-brand-teal" aria-hidden="true"/>{feature}</li>)}
          </ul>
          <a href={p.free?'/portal/':`/portal/${cycle==='annual'?'?ciclo=anual':''}#comprar`} className={`mt-auto inline-flex items-center justify-center gap-2 rounded-full px-4 py-3 text-sm font-bold ${best?'bg-brand text-white hover:bg-[#004a8f]':'border border-brand/25 text-brand hover:bg-brand/5'}`}>{p.free?'Empezar gratis':'Elegir plan'}<ArrowRight className="h-4 w-4" aria-hidden="true"/></a>
        </article>;
      })}
    </div>
    <div className="mt-8 flex flex-col items-center justify-between gap-5 rounded-2xl border border-brand-teal/20 bg-brand-teal/5 px-6 py-6 text-left sm:flex-row"><div><h3 className="text-lg font-bold text-navy">Prueba Xport Full durante 14 días</h3><p className="mt-1 text-sm text-slate-600">Todas las opciones, sin tarjeta. Al terminar, continúas en Gratuito.</p></div><a href="/portal/#prueba" className="inline-flex shrink-0 items-center gap-2 text-sm font-bold text-brand">Activar mi prueba Full<ArrowRight className="h-4 w-4"/></a></div>
    <p className="mt-6 text-center text-xs leading-relaxed text-slate-500">Precios en soles. Sin renovación automática. Cada archivo principal cuenta: un PDF combinado cuenta como uno. El cupo gratuito se renueva el primer día del mes en Perú.</p>
  </div>;
}
