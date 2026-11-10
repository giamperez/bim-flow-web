import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useInView } from 'motion/react';
import { Check, Play, RotateCcw } from 'lucide-react';

type Sheet = { code: string; name: string; rev: string; size: string };

const sheets: Sheet[] = [
  { code: 'A-101', name: 'Planta-N01', rev: 'R03', size: 'ARCH D' },
  { code: 'S-201', name: 'Cimentaciones', rev: 'R02', size: 'ARCH D' },
  { code: 'M-301', name: 'Climatizacion', rev: 'R01', size: 'ARCH E' },
  { code: 'E-401', name: 'Cuadro-Cargas', rev: 'R01', size: 'A1' },
];

const patterns = [
  { label: 'Nº_Nombre_Rev', fn: (s: Sheet) => `${s.code}_${s.name}_${s.rev}.pdf` },
  { label: 'Proyecto-Nº', fn: (s: Sheet) => `TORRE-N_${s.code}.pdf` },
  { label: 'Nº_Rev', fn: (s: Sheet) => `${s.code}_${s.rev}.pdf` },
];

const empty = sheets.map(() => 0);

export function InteractiveWorkflowDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: '-120px' });
  const [progress, setProgress] = useState(empty);
  const [running, setRunning] = useState(false);
  const [pattern, setPattern] = useState(0);

  const allDone = progress.every((p) => p >= 100);
  const done = progress.filter((p) => p >= 100).length;
  const total = Math.round(progress.reduce((a, b) => a + b, 0) / sheets.length);

  // Auto-start the first time it scrolls into view
  useEffect(() => {
    if (inView) setRunning(true);
  }, [inView]);

  useEffect(() => {
    if (!running) return;
    if (allDone) {
      setRunning(false);
      return;
    }
    const i = setInterval(() => {
      setProgress((prev) => {
        const idx = prev.findIndex((p) => p < 100);
        return prev.map((p, j) => (j === idx ? Math.min(100, p + 6) : p));
      });
    }, 90);
    return () => clearInterval(i);
  }, [running, allDone]);

  const restart = () => {
    setProgress(empty);
    setRunning(true);
  };

  return (
    <div
      ref={ref}
      className="overflow-hidden rounded-2xl border border-line bg-ink-2/80 shadow-[0_40px_120px_-40px_rgba(34,211,238,0.3)] backdrop-blur"
    >
      {/* Window chrome */}
      <div className="flex items-center justify-between border-b border-line px-4 py-3 sm:px-5">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
        </div>
        <span className="font-mono text-[11px] text-muted">BinFlow · Entrega_03</span>
        <span className={`h-2 w-2 rounded-full ${running ? 'animate-pulse bg-accent' : 'bg-white/20'}`} />
      </div>

      {/* Naming rule selector */}
      <div className="border-b border-line px-4 py-4 sm:px-5">
        <p className="font-mono text-[10px] tracking-[0.14em] text-subtle uppercase">Regla de nombre</p>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {patterns.map((p, i) => (
            <button
              key={p.label}
              onClick={() => setPattern(i)}
              className={`relative cursor-pointer rounded-full px-3 py-1.5 font-mono text-[11px] transition-colors ${
                pattern === i ? 'text-ink' : 'text-muted hover:text-white'
              }`}
            >
              {pattern === i && (
                <motion.span
                  layoutId="pattern-pill"
                  className="absolute inset-0 rounded-full bg-accent"
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                />
              )}
              <span className="relative">{p.label}</span>
            </button>
          ))}
        </div>
      </div>

      <ul className="divide-y divide-line">
        {sheets.map((s, i) => {
          const p = progress[i];
          const ok = p >= 100;
          const active = running && !ok && progress.findIndex((x) => x < 100) === i;
          const label = ok ? patterns[pattern].fn(s) : s.code;
          return (
            <li
              key={s.code}
              className={`flex items-center gap-3.5 px-4 py-3.5 transition-colors sm:gap-4 sm:px-5 ${active ? 'bg-accent/[0.04]' : ''}`}
            >
              <motion.span
                animate={ok ? { scale: [0.6, 1.15, 1] } : { scale: 1 }}
                transition={{ duration: 0.4 }}
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-colors ${
                  ok ? 'border-accent bg-accent text-ink' : active ? 'border-accent/60 text-accent' : 'border-line text-subtle'
                }`}
              >
                {ok ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : <span className="font-mono text-[10px]">{i + 1}</span>}
              </motion.span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="relative h-5 min-w-0 flex-1 overflow-hidden">
                    <AnimatePresence mode="popLayout" initial={false}>
                      <motion.p
                        key={label}
                        initial={{ y: 14, opacity: 0 }}
                        animate={{ y: 0, opacity: 1 }}
                        exit={{ y: -14, opacity: 0 }}
                        transition={{ duration: 0.25 }}
                        className="truncate font-mono text-[12px] leading-5 text-white sm:text-[13px]"
                      >
                        {label}
                      </motion.p>
                    </AnimatePresence>
                  </div>
                  <span className="shrink-0 font-mono text-[11px] text-subtle">{s.size}</span>
                </div>
                <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-white/5">
                  <div className="h-full rounded-full bg-accent transition-[width] duration-100" style={{ width: `${p}%` }} />
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 sm:px-5">
        <div className="min-w-0 font-mono text-[11px]">
          <p className="text-muted">
            {done}/{sheets.length} láminas · {total}%
          </p>
          <p className={allDone ? 'text-accent' : 'text-subtle'}>{allDone ? 'Set completo' : 'Revit disponible'}</p>
        </div>
        <button
          onClick={restart}
          disabled={running}
          className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-accent/40 px-4 py-2 text-xs font-medium text-white transition-colors hover:border-accent hover:bg-accent hover:text-ink disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-white"
        >
          {allDone ? <RotateCcw className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {allDone ? 'Repetir' : 'Exportar'}
        </button>
      </div>
    </div>
  );
}
