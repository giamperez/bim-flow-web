import { useEffect, useState } from 'react';
import { ArrowRight, Check, Sparkles } from 'lucide-react';

type Plan = {
  id: string;
  name: string;
  displayName?: string;
  free: boolean;
  cycle: string;
  seconds: number;
  devices: number;
  priceCents: number;
  currency: string;
  monthlyLimit: number;
  description: string;
};

const fallback: Plan[] = [
  {
    id: 'gratis',
    name: 'Gratuito',
    displayName: 'Gratuito',
    free: true,
    cycle: 'free',
    seconds: 0,
    devices: 1,
    priceCents: 0,
    currency: 'PEN',
    monthlyLimit: 150,
    description: 'PDF y DWG con los ajustes esenciales para entregas ágiles.',
  },
  ...([
    ['mensual', 'Individual', 1, 1990, 15900],
    ['equipo', 'Equipo', 3, 4990, 39900],
    ['estudio', 'Estudio', 7, 9990, 79900],
  ] as const).flatMap(([id, name, devices, monthly, annual]) =>
    (['monthly', 'annual'] as const).map((cycle) => ({
      id: cycle === 'monthly' ? String(id) : id === 'mensual' ? 'anual' : id + '_anual',
      name: String(name),
      displayName: String(name),
      free: false,
      cycle,
      seconds: (cycle === 'monthly' ? 30 : 365) * 86400,
      devices: Number(devices),
      priceCents: Number(cycle === 'monthly' ? monthly : annual),
      currency: 'PEN',
      monthlyLimit: 0,
      description: 'Todos los formatos, perfiles guardados y exportaciones ilimitadas.',
    }))
  ),
];

const money = (cents: number) => 'S/ ' + (cents / 100).toFixed(2);

export function Pricing() {
  const [plans, setPlans] = useState<Plan[]>(fallback);
  const [cycle, setCycle] = useState<'monthly' | 'annual'>('monthly');

  useEffect(() => {
    const controller = new AbortController();
    fetch('/portal/api/plans', { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j) => {
        if (Array.isArray(j.plans) && j.plans.some((p: Plan) => p.cycle === 'annual')) {
          setPlans(j.plans);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  return (
    <div>
      {/* Selector de ciclo Mensual / Anual */}
      <div className="mb-12 flex justify-center">
        <div
          className="inline-flex items-center gap-1.5 rounded-full border border-slate-200/90 bg-slate-100/90 p-1.5 shadow-inner"
          role="group"
          aria-label="Período de facturación"
        >
          <button
            type="button"
            onClick={() => setCycle('monthly')}
            aria-pressed={cycle === 'monthly'}
            className={`cursor-pointer rounded-full px-6 py-2.5 text-sm font-bold transition-all duration-200 ${
              cycle === 'monthly'
                ? 'bg-white text-brand shadow-sm'
                : 'text-slate-600 hover:text-navy'
            }`}
          >
            Facturación Mensual
          </button>
          <button
            type="button"
            onClick={() => setCycle('annual')}
            aria-pressed={cycle === 'annual'}
            className={`cursor-pointer rounded-full px-6 py-2.5 text-sm font-bold transition-all duration-200 ${
              cycle === 'annual'
                ? 'bg-white text-brand shadow-sm'
                : 'text-slate-600 hover:text-navy'
            }`}
          >
            Facturación Anual
            <span className="ml-2 inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-extrabold text-emerald-800">
              Ahorra 33%
            </span>
          </button>
        </div>
      </div>

      {/* Grid de Planes */}
      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
        {plans
          .filter((p) => p.free || p.cycle === cycle)
          .map((p) => {
            const best = p.devices === 3;
            return (
              <article
                key={p.id}
                className={`relative flex flex-col rounded-[26px] border bg-white p-7 text-left transition-all duration-300 hover:-translate-y-1.5 ${
                  best
                    ? 'border-brand/70 shadow-[0_20px_50px_-20px_rgba(0,91,174,0.35)] ring-2 ring-brand/20'
                    : 'border-slate-200/90 shadow-[0_10px_30px_-15px_rgba(3,26,53,0.06)] hover:border-slate-300 hover:shadow-xl'
                }`}
              >
                {best && (
                  <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 rounded-full bg-gradient-to-r from-brand to-brand-teal px-4 py-1 text-[11px] font-extrabold tracking-wider text-white uppercase shadow-md flex items-center gap-1.5 whitespace-nowrap">
                    <Sparkles className="h-3.5 w-3.5" /> Más Popular · Equipo
                  </div>
                )}

                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-bold tracking-wider text-slate-400 uppercase">
                    {p.free ? 'Xport Gratuito' : 'Xport Full'}
                  </span>
                  {!p.free && (
                    <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[10.5px] font-bold text-slate-600">
                      {p.devices} {p.devices === 1 ? 'PC' : 'PCs'}
                    </span>
                  )}
                </div>

                <h3 className="mt-2 text-2xl font-extrabold tracking-tight text-navy">
                  {p.displayName || p.name}
                </h3>

                <div className="mt-5 border-b border-slate-100 pb-5">
                  <p className="text-[36px] leading-tight font-extrabold tracking-tight whitespace-nowrap text-navy">
                    {p.free ? 'Gratis' : money(p.priceCents)}
                  </p>
                  <p className="mt-1 text-xs font-medium text-slate-500">
                    {p.free
                      ? 'Sin tarjeta · Para siempre'
                      : cycle === 'annual'
                      ? 'al año · pago único por 365 días'
                      : 'al mes · pago único por 30 días'}
                  </p>
                </div>

                <p className="mt-4 min-h-[44px] text-[13px] leading-relaxed text-slate-600">
                  {p.description}
                </p>

                <ul className="my-6 grid gap-3 text-[13px] text-slate-600">
                  {[
                    `${p.devices} computadora${p.devices === 1 ? '' : 's'} por licencia`,
                    p.free ? '150 archivos al mes calendario' : 'Archivos y lotes sin límite',
                    p.free ? 'Formatos esenciales PDF y DWG' : 'Formatos PDF, DWG, DXF, PNG, JPG y TIFF',
                    p.free
                      ? 'Selección, color y PDF combinado'
                      : 'Ajustes avanzados y perfiles reutilizables',
                  ].map((feature) => (
                    <li className="flex items-start gap-2.5" key={feature}>
                      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-teal-50 text-brand-teal">
                        <Check className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden="true" />
                      </span>
                      <span className="leading-snug">{feature}</span>
                    </li>
                  ))}
                </ul>

                <a
                  href={p.free ? '/portal/' : `/portal/${cycle === 'annual' ? '?ciclo=anual' : ''}#comprar`}
                  className={`mt-auto inline-flex items-center justify-center gap-2 rounded-full px-5 py-3.5 text-sm font-bold transition-all duration-200 ${
                    best
                      ? 'bg-gradient-to-r from-brand to-[#0a6fcc] text-white shadow-md hover:brightness-105 hover:shadow-lg'
                      : 'border border-brand/30 bg-white text-brand hover:border-brand hover:bg-brand/5'
                  }`}
                >
                  {p.free ? 'Empezar gratis' : 'Elegir plan'}
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </a>
              </article>
            );
          })}
      </div>

      {/* Banner de Prueba Full */}
      <div className="mt-10 flex flex-col items-center justify-between gap-6 rounded-2xl border border-brand-teal/30 bg-gradient-to-r from-brand-teal/[0.08] via-brand/[0.04] to-white p-7 text-left shadow-sm sm:flex-row">
        <div>
          <span className="inline-block rounded-full bg-brand-teal/15 px-3 py-1 text-[11px] font-bold tracking-wide text-brand-teal uppercase">
            Sin tarjeta de crédito
          </span>
          <h3 className="mt-2 text-xl font-extrabold text-navy">
            ¿Quieres probar antes? Descubre Xport Full por 14 días
          </h3>
          <p className="mt-1 text-sm text-slate-600">
            Exporta sin límite de archivos con todos los formatos y opciones avanzadas. Al terminar, tu cuenta continúa en el plan Gratuito.
          </p>
        </div>
        <a
          href="/portal/#prueba"
          className="btn-primary inline-flex shrink-0 items-center gap-2 rounded-full px-6 py-3 text-sm font-bold shadow-md hover:shadow-lg"
        >
          Activar prueba Full
          <ArrowRight className="h-4 w-4" />
        </a>
      </div>

      <p className="mt-6 text-center text-xs leading-relaxed text-slate-500">
        Precios en soles (PEN) con todos los impuestos incluidos. Sin suscripciones ocultas ni renovación automática: solo pagas cuando decides extender tu plan.
      </p>
    </div>
  );
}
