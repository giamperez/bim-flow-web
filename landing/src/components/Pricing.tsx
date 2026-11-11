import { useEffect, useState } from 'react';
import { ArrowRight, Check, Sparkles } from 'lucide-react';

type Plan = { id: string; name: string; trial: boolean; seconds: number; devices: number; priceCents: number; currency: string; description: string };
type Tier = { index: number; name: string; slotsLeft: number | null; trialDays: number; nextPrices: Record<string, number> | null; nextName: string | null };
type Data = { plans: Plan[]; tier: Tier | null };

// Valores de respaldo: se muestran mientras carga o si el servidor no responde. El precio real lo manda el servidor.
const fallback: Data = {
  tier: null,
  plans: [
    { id: 'prueba', name: 'Gratuito', trial: true, seconds: 30 * 86400, devices: 1, priceCents: 0, currency: 'PEN', description: 'Un mes para empezar. Una exportación al día.' },
    { id: 'mensual', name: 'Individual', trial: false, seconds: 30 * 86400, devices: 1, priceCents: 1990, currency: 'PEN', description: 'Tu espacio de trabajo, sin límite diario de exportaciones.' },
    { id: 'equipo', name: 'Equipo', trial: false, seconds: 30 * 86400, devices: 3, priceCents: 4990, currency: 'PEN', description: 'Una licencia para tres computadoras.' },
    { id: 'estudio', name: 'Estudio', trial: false, seconds: 30 * 86400, devices: 7, priceCents: 9990, currency: 'PEN', description: 'Una licencia para siete computadoras.' },
  ],
};

const money = (cents: number, currency: string) =>
  `${currency === 'PEN' ? 'S/' : currency} ${(cents / 100).toLocaleString('es', { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;

function duration(seconds: number) {
  const days = Math.round(seconds / 86400);
  if (days >= 360) return '1 año';
  if (days === 30) return '1 mes';
  return `${days} días`;
}

export function Pricing() {
  const [data, setData] = useState<Data>(fallback);

  useEffect(() => {
    let alive = true;
    fetch('/portal/api/plans')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j) => alive && Array.isArray(j.plans) && j.plans.length > 0 && setData({ plans: j.plans, tier: j.tier ?? null }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const { plans, tier } = data;
  const monthly = plans.find((p) => p.id === 'mensual');
  const nextMonthly = tier?.nextPrices?.mensual;

  return (
    <div>
      {tier && tier.slotsLeft !== null && (
        <div className="mx-auto mb-10 flex max-w-2xl items-start gap-3 rounded-2xl border border-brand-teal/30 bg-brand-teal/[0.07] px-5 py-4 text-left sm:items-center">
          <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-brand-teal sm:mt-0" aria-hidden="true" />
          <p className="text-sm leading-relaxed text-navy">
            <b>Precio de lanzamiento: quedan {tier.slotsLeft} cupo{tier.slotsLeft === 1 ? '' : 's'}.</b>{' '}
            {nextMonthly && monthly ? `Después, el plan mensual pasa de ${money(monthly.priceCents, monthly.currency)} a ${money(nextMonthly, monthly.currency)}. ` : ''}
            Quien se une ahora conserva su precio.
          </p>
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
        {plans.map((p) => {
          const best = p.id === 'equipo';
          const perMonth = p.id === 'anual' ? p.priceCents / 12 : null;
          return (
            <div
              key={p.id}
              className={`relative flex flex-col rounded-3xl border p-7 text-left ${
                best ? 'border-brand bg-white shadow-[0_30px_70px_-30px_rgba(0,91,174,0.45)]' : 'border-slate-200 bg-white/80'
              }`}
            >
              {best && (
                <span className="absolute -top-3 left-7 rounded-full bg-brand px-3 py-1 text-[11px] font-bold tracking-wider text-white uppercase">Más conveniente</span>
              )}
              {p.trial && (
                <span className="absolute -top-3 left-7 rounded-full bg-brand-teal px-3 py-1 text-[11px] font-bold tracking-wider text-navy uppercase">Sin tarjeta</span>
              )}
              <h3 className="text-lg font-bold text-navy">{p.name}</h3>
              <p className="mt-4 flex flex-wrap items-baseline gap-2">
                <span className="text-4xl font-extrabold tracking-tight text-navy">{p.priceCents === 0 ? 'Gratis' : money(p.priceCents, p.currency)}</span>
                {p.priceCents > 0 && <span className="text-sm text-slate-500">/ {duration(p.seconds)}</span>}
              </p>
              {perMonth && <p className="mt-1 text-xs text-slate-500">Equivale a {money(Math.round(perMonth), p.currency)} al mes</p>}
              <p className="mt-4 text-sm text-slate-600">{p.description}</p>
              <ul className="mt-6 grid gap-2.5 text-sm text-slate-700">
                {[
                  `Hasta ${p.devices} equipo${p.devices === 1 ? '' : 's'}`,
                  p.trial ? '1 exportación diaria por 30 días' : 'Sin límite diario de exportaciones',
                  'PDF, DWG, DXF, PNG, JPG y TIFF',
                  'Revit 2023 a 2027',
                  'Reintento de fallidos y reportes',
                ].map((f) => (
                  <li key={f} className="flex items-start gap-2.5">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand-teal" strokeWidth={3} aria-hidden="true" />
                    {f}
                  </li>
                ))}
              </ul>
              <a
                href="/portal/#comprar"
                className={`mt-8 inline-flex items-center justify-center gap-2 rounded-full px-6 py-3 text-sm font-bold transition-colors ${
                  best || p.trial ? 'bg-brand text-white hover:bg-[#004a8f]' : 'border border-brand/30 text-brand hover:bg-brand/5'
                }`}
              >
                {p.trial ? 'Empezar prueba gratis' : 'Elegir plan'}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </a>
            </div>
          );
        })}
      </div>
      <p className="mt-6 text-center text-xs text-slate-500">La prueba gratuita es una por equipo y por cuenta. Precios en soles (PEN).</p>
    </div>
  );
}
