import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Check, FileSpreadsheet, FolderArchive, RotateCw } from 'lucide-react';

type Job = { sheet: string; name: string; format: 'PDF' | 'DWG' | 'DXF' | 'PNG' };

// Ejemplo ilustrativo del avance de una entrega por lotes (no son datos reales).
const jobs: Job[] = [
  { sheet: 'A-101', name: 'Planta nivel 1', format: 'PDF' },
  { sheet: 'A-102', name: 'Planta nivel 2', format: 'PDF' },
  { sheet: 'A-201', name: 'Cortes generales', format: 'DWG' },
  { sheet: 'A-301', name: 'Elevaciones', format: 'DXF' },
  { sheet: 'S-101', name: 'Cimentación', format: 'PDF' },
  { sheet: 'S-201', name: 'Detalles', format: 'PNG' },
];

const formatColor: Record<Job['format'], string> = {
  PDF: 'bg-[#00afb7]/15 text-[#5fe0e6]',
  DWG: 'bg-[#3b8fe0]/20 text-[#8cc4ff]',
  DXF: 'bg-[#3b8fe0]/20 text-[#8cc4ff]',
  PNG: 'bg-white/10 text-slate-200',
};

/** Tarjeta oscura que simula el avance de un lote: cada operación pasa de pendiente a lista. */
export function ExportShowcase() {
  const [done, setDone] = useState(0);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDone(jobs.length);
      return;
    }
    const id = window.setInterval(() => setDone((d) => (d >= jobs.length + 2 ? 0 : d + 1)), 900);
    return () => window.clearInterval(id);
  }, []);

  const finished = done >= jobs.length;
  const pct = Math.min(100, Math.round((Math.min(done, jobs.length) / jobs.length) * 100));

  return (
    <div
      className="overflow-hidden rounded-3xl border border-white/10 bg-[#061f3f]/90 shadow-[0_40px_90px_-30px_rgba(0,91,174,0.55)] backdrop-blur"
      role="img"
      aria-label="Simulación del avance de una exportación por lotes"
    >
      <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
        <div className="flex items-center gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-white/20" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/20" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/20" />
        </div>
        <span className="text-[11px] font-medium tracking-[0.16em] text-slate-300 uppercase">BIM FLOW · Entrega 03</span>
        <span className={`h-2 w-2 rounded-full ${finished ? 'bg-[#00afb7]' : 'animate-pulse bg-[#00afb7]'}`} aria-hidden="true" />
      </div>

      <ul className="divide-y divide-white/[0.06]">
        {jobs.map((job, i) => {
          const state = i < done ? 'done' : i === done ? 'running' : 'pending';
          return (
            <li key={job.sheet} className="flex items-center gap-3 px-5 py-3">
              <span className="w-12 shrink-0 text-xs font-semibold text-slate-400">{job.sheet}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-slate-100">{job.name}</span>
              <span className={`rounded-md px-2 py-0.5 text-[10px] font-bold tracking-wider ${formatColor[job.format]}`}>{job.format}</span>
              <span className="flex h-5 w-5 items-center justify-center" aria-hidden="true">
                {state === 'done' && (
                  <motion.span initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="flex h-5 w-5 items-center justify-center rounded-full bg-[#00afb7]">
                    <Check className="h-3 w-3 text-[#031a35]" strokeWidth={3.5} />
                  </motion.span>
                )}
                {state === 'running' && <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#00afb7] border-t-transparent" />}
                {state === 'pending' && <span className="h-2 w-2 rounded-full bg-white/20" />}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="border-t border-white/10 px-5 py-4">
        <div className="mb-2 flex items-center justify-between text-xs text-slate-300">
          <span>{finished ? 'Entrega completa' : 'Exportando…'}</span>
          <span className="font-semibold text-white">{Math.min(done, jobs.length)} de {jobs.length} operaciones</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-white/10">
          <motion.div className="h-full rounded-full bg-gradient-to-r from-[#005bae] to-[#00afb7]" animate={{ width: `${pct}%` }} transition={{ duration: 0.5, ease: 'easeOut' }} />
        </div>
        <div className="mt-4 flex flex-wrap gap-2 text-[11px] text-slate-200">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1"><FileSpreadsheet className="h-3 w-3 text-[#5fe0e6]" /> reporte.csv</span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1"><FolderArchive className="h-3 w-3 text-[#5fe0e6]" /> entrega.zip</span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1"><RotateCw className="h-3 w-3 text-[#5fe0e6]" /> Reintentar solo los fallidos</span>
        </div>
      </div>
    </div>
  );
}
