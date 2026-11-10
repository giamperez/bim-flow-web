import { useId } from 'react';
import { motion } from 'motion/react';

const reducedMotion =
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Floor plan strokes, grouped by role so each draws with its own color and timing. */
const walls = [
  'M40 40 H300 V240 H40 Z',
  'M40 130 H150',
  'M180 130 H300',
  'M150 40 V95',
  'M150 125 V240',
  'M220 130 V240',
];
const doors = ['M150 95 A30 30 0 0 1 180 125', 'M220 175 A28 28 0 0 0 248 203', 'M95 240 A26 26 0 0 1 69 214'];
const dims = ['M40 22 H300', 'M40 17 V27', 'M150 17 V27', 'M300 17 V27', 'M318 40 V240', 'M313 40 H323', 'M313 240 H323'];
const furniture = ['M60 60 h60 v40 h-60 z', 'M240 60 a22 22 0 1 0 0.1 0', 'M240 160 h45 v60 h-45 z', 'M60 160 h50 v25 h-50 z'];
const titleBlock = ['M340 40 H380 V240 H340 Z', 'M340 80 H380', 'M340 120 H380', 'M340 200 H380'];

type Props = { className?: string; loop?: boolean; delay?: number };

export function PlanDrawing({ className = '', loop = false, delay = 0 }: Props) {
  const gid = `plan-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const brand = `url(#${gid})`;
  const draw = (i: number, dur = 1.1) => ({
    initial: { pathLength: reducedMotion ? 1 : 0, opacity: reducedMotion ? 1 : 0 },
    whileInView: { pathLength: 1, opacity: 1 },
    viewport: { once: !loop, margin: '-60px' },
    transition: {
      pathLength: {
        duration: dur,
        delay: delay + i * 0.12,
        ease: 'easeInOut' as const,
        ...(loop && !reducedMotion ? { repeat: Infinity, repeatType: 'reverse' as const, repeatDelay: 2.5 } : {}),
      },
      opacity: { duration: 0.3, delay: delay + i * 0.12 },
    },
  });

  let i = 0;
  return (
    <svg viewBox="0 0 400 270" fill="none" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#3b82f6" />
        </linearGradient>
      </defs>
      {walls.map((d) => (
        <motion.path key={d} d={d} stroke={brand} strokeWidth={4} strokeLinecap="square" {...draw(i++, 1.3)} />
      ))}
      {doors.map((d) => (
        <motion.path key={d} d={d} stroke="#a5f3fc" strokeWidth={1.5} strokeDasharray="0" {...draw(i++)} />
      ))}
      {furniture.map((d) => (
        <motion.path key={d} d={d} stroke="#3b82f6" strokeOpacity={0.7} strokeWidth={1.5} {...draw(i++)} />
      ))}
      {dims.map((d) => (
        <motion.path key={d} d={d} stroke="#7dd3fc" strokeOpacity={0.5} strokeWidth={1} {...draw(i++, 0.6)} />
      ))}
      {titleBlock.map((d) => (
        <motion.path key={d} d={d} stroke="#22d3ee" strokeOpacity={0.6} strokeWidth={1.5} {...draw(i++, 0.7)} />
      ))}
      <motion.rect
        x={345}
        y={210}
        width={30}
        height={22}
        rx={2}
        fill={loop ? 'none' : brand}
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true }}
        transition={{ delay: delay + i * 0.12 }}
      />
    </svg>
  );
}
