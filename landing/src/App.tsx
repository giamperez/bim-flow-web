import { Fragment, lazy, Suspense, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { motion, AnimatePresence, useScroll, useSpring, useTransform } from 'motion/react';
import { ArrowRight, Plus, Check, ScanLine, FileSignature, Cpu } from 'lucide-react';
import { InteractiveWorkflowDemo } from './components/InteractiveWorkflowDemo';
import { PlanDrawing } from './components/PlanDrawing';
// Real photos (Wikimedia Commons, CC0 / public domain)
import torres from './assets/photos/torres.jpg';

/** Brand photos served from /public/images (optimized JPEG, full HD + 960px for mobile). */
const brandImages = {
  hero: { name: 'hero-revit', alt: 'Estación de trabajo con un modelo BIM 3D y su planta en Revit' },
  architect: { name: 'arquitecto-planos', alt: 'Arquitecto dibujando planos junto a una maqueta' },
  review: { name: 'revision-planos', alt: 'Revisión de planos impresos con el modelo BIM en el portátil' },
} as const;

function BrandImage({
  image,
  className = '',
  sizes = '100vw',
  priority = false,
  decorative = false,
}: {
  image: (typeof brandImages)[keyof typeof brandImages];
  className?: string;
  sizes?: string;
  priority?: boolean;
  decorative?: boolean;
}) {
  return (
    <img
      src={`/images/${image.name}.jpg`}
      srcSet={`/images/${image.name}-960.jpg 960w, /images/${image.name}.jpg 1672w`}
      sizes={sizes}
      width={1672}
      height={941}
      alt={decorative ? '' : image.alt}
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : 'auto'}
      decoding="async"
      className={className}
    />
  );
}

const BimCanvas = lazy(() => import('./components/BimCanvas'));

const faqs = [
  {
    q: '¿Cómo funciona dentro de Revit?',
    a: 'BinFlow lee tus conjuntos de láminas, detecta el formato de cada carátula (A0, A1, ARCH D…) y genera PDFs vectoriales sin recortes.',
  },
  {
    q: '¿Puedo usar mi propia nomenclatura?',
    a: 'Sí. Usa parámetros nativos de Revit para nombrar cada archivo, por ejemplo [Número]_[Nombre]_[Revisión].pdf.',
  },
  {
    q: '¿Revit se bloquea durante la exportación?',
    a: 'No. El proceso corre en segundo plano y optimiza memoria para que tu equipo siga modelando.',
  },
  {
    q: '¿Mis archivos salen de mi equipo?',
    a: 'Nunca. BinFlow es una aplicación de escritorio y todo se procesa de forma local.',
  },
];

const manualSteps = ['Abrir lámina', 'Configurar impresora', 'Ajustar formato', 'Exportar', 'Renombrar'];

function Reveal({ children, delay = 0, className = '' }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.7, delay, ease: [0.22, 1, 0.36, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

function Logo() {
  return (
    <a href="#" className="flex items-center gap-2.5" aria-label="BinFlow, inicio">
      <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id="logo-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#22d3ee" />
            <stop offset="1" stopColor="#3b82f6" />
          </linearGradient>
        </defs>
        <rect x="3" y="3" width="18" height="18" rx="4" stroke="url(#logo-g)" strokeWidth="1.8" />
        <path d="M7 9h10M7 12h7M7 15h4" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <span className="text-[17px] font-semibold tracking-tight text-white">BinFlow</span>
    </a>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="font-mono text-xs uppercase tracking-[0.18em] text-accent">{children}</p>;
}

/** Panel with a soft cyan light that follows the cursor. */
function Spotlight({ children, className = '' }: { children: ReactNode; className?: string }) {
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty('--x', `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty('--y', `${e.clientY - r.top}px`);
  };
  return (
    <div onPointerMove={onMove} className={`spotlight group relative overflow-hidden ${className}`}>
      {children}
    </div>
  );
}

const ease = [0.22, 1, 0.36, 1] as const;
const heroWords = [
  { w: 'Tus', accent: false },
  { w: 'planos,', accent: false, br: true },
  { w: 'en', accent: false },
  { w: 'un', accent: false },
  { w: 'clic.', accent: true },
];


export function App() {
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  const { scrollYProgress } = useScroll();
  const progressX = useSpring(scrollYProgress, { stiffness: 120, damping: 24 });

  const stepsRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress: stepsProgress } = useScroll({ target: stepsRef, offset: ['start 85%', 'end 60%'] });
  const stepsLine = useSpring(stepsProgress, { stiffness: 90, damping: 22 });

  // Gentle parallax for the photo band
  const bandRef = useRef<HTMLElement>(null);
  const { scrollYProgress: bandProgress } = useScroll({ target: bandRef, offset: ['start end', 'end start'] });
  const bandY = useTransform(bandProgress, [0, 1], ['-8%', '8%']);

  const handleDemo = (e: React.FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!value) return;
    setSent(true);
    // Se guarda la solicitud para que el equipo la vea en el panel de administración.
    fetch('/portal/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'bimflow' },
      body: JSON.stringify({ email: value }),
    }).catch(() => {});
  };

  return (
    <div className="min-h-screen bg-ink text-slate-200">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-line bg-ink/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
          <Logo />
          <nav className="hidden items-center gap-9 text-sm text-muted md:flex">
            <a href="#problema" className="transition-colors hover:text-white">Por qué</a>
            <a href="#proceso" className="transition-colors hover:text-white">Cómo funciona</a>
            <a href="#faq" className="transition-colors hover:text-white">FAQ</a>
          </nav>
          <div className="flex items-center gap-3">
            <a href="/portal/" className="hidden text-sm font-medium text-slate-300 transition-colors hover:text-white sm:inline">
              Mi cuenta
            </a>
            <a href="/portal/#comprar" className="btn-brand rounded-full px-4 py-2 text-sm font-semibold">
              Comprar licencia
            </a>
          </div>
        </div>
        <motion.div
          style={{ scaleX: progressX }}
          className="absolute inset-x-0 -bottom-px h-0.5 origin-left bg-gradient-to-r from-accent via-accent-2 to-glow"
        />
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        {/* HD Revit workstation as atmospheric background; gradients keep text and 3D legible */}
        <motion.div
          initial={{ opacity: 0, scale: 1.06 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 1.6, ease }}
          className="media pointer-events-none absolute inset-0"
          aria-hidden="true"
        >
          <BrandImage image={brandImages.hero} priority decorative className="object-[70%_center] opacity-40" />
        </motion.div>
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-ink via-ink/85 to-ink/30" />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink via-transparent to-ink/60" />
        <div className="grid-fade pointer-events-none absolute inset-0 opacity-60" />
        <div className="pointer-events-none absolute -top-40 left-1/3 h-[520px] w-[760px] -translate-x-1/2 rounded-full bg-blue-600/20 blur-[140px]" />

        <div className="relative mx-auto grid max-w-6xl items-center gap-4 px-5 pt-16 pb-10 sm:px-8 lg:min-h-[calc(100vh-4rem)] lg:grid-cols-[1fr_1.15fr] lg:pt-0 lg:pb-0">
          <div className="max-w-xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
            >
              <p className="inline-flex items-center gap-2 rounded-full border border-line px-3 py-1 text-xs text-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                Automatización para Revit
              </p>
              <h1 className="mt-6 text-[2.75rem] leading-[1.05] font-semibold tracking-[-0.045em] text-white sm:text-6xl lg:text-7xl">
                {heroWords.map(({ w, accent, br }, i) => (
                  <Fragment key={w}>
                    <span className="inline-block overflow-hidden pb-1 align-bottom">
                      <motion.span
                        initial={{ y: '105%' }}
                        animate={{ y: 0 }}
                        transition={{ duration: 0.9, delay: 0.15 + i * 0.08, ease }}
                        className={`inline-block ${accent ? 'shimmer-text' : ''}`}
                      >
                        {w}
                      </motion.span>
                    </span>
                    {br ? <br /> : ' '}
                  </Fragment>
                ))}
              </h1>
              <p className="mt-6 max-w-md text-lg leading-relaxed text-muted">
                BinFlow exporta el set completo de láminas a PDF: detecta el formato y nombra cada archivo por ti.
              </p>
              <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
                <a
                  href="#contacto"
                  className="btn-brand group inline-flex items-center justify-center gap-2 overflow-hidden rounded-full px-7 py-3.5 font-semibold"
                >
                  <span className="btn-sheen" />
                  <span className="relative">Solicitar demo</span>
                  <ArrowRight className="relative h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </a>
                <a href="/portal/#comprar" className="text-center text-sm font-semibold text-white underline-offset-4 hover:underline">
                  Comprar licencia
                </a>
                <a href="#proceso" className="text-center text-sm font-medium text-slate-300 transition-colors hover:text-white">
                  Ver cómo funciona
                </a>
              </div>
            </motion.div>
          </div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1.4, delay: 0.2 }}
            className="relative -mx-5 h-[360px] sm:mx-0 sm:h-[460px] lg:-mr-24 lg:h-[680px]"
          >
            <Suspense fallback={null}>
              <BimCanvas />
            </Suspense>
          </motion.div>
        </div>
      </section>

      {/* Problem vs solution */}
      <section id="problema" className="surface-glow border-t border-line py-24 sm:py-32">
        <div className="mx-auto max-w-6xl px-5 sm:px-8">
          <Reveal className="max-w-3xl">
            <Eyebrow>El problema</Eyebrow>
            <h2 className="mt-5 text-3xl leading-tight font-semibold tracking-[-0.03em] text-white sm:text-5xl">
              Cada entrega repite el mismo ritual.{' '}
              <span className="text-subtle">Lámina por lámina, clic por clic.</span>
            </h2>
          </Reveal>

          <div className="mt-16 grid gap-px overflow-hidden rounded-2xl border border-line bg-line md:grid-cols-2">
            <Spotlight className="bg-ink p-8 sm:p-10">
              <p className="relative text-sm text-subtle">Sin BinFlow</p>
              <motion.ol
                initial="hidden"
                whileInView="show"
                viewport={{ once: true, margin: '-80px' }}
                variants={{ show: { transition: { staggerChildren: 0.12 } } }}
                className="relative mt-6 space-y-3"
              >
                {manualSteps.map((s, i) => (
                  <motion.li
                    key={s}
                    variants={{ hidden: { opacity: 0, x: -16 }, show: { opacity: 1, x: 0, transition: { duration: 0.5, ease } } }}
                    className="flex items-center gap-4 text-muted"
                  >
                    <span className="font-mono text-xs text-faint">0{i + 1}</span>
                    <span className="relative">
                      {s}
                      <motion.span
                        variants={{ hidden: { scaleX: 0 }, show: { scaleX: 1, transition: { duration: 0.5, delay: 0.9, ease } } }}
                        className="absolute top-1/2 left-0 h-px w-full origin-left bg-subtle/70"
                      />
                    </span>
                  </motion.li>
                ))}
              </motion.ol>
              <p className="relative mt-8 font-mono text-sm text-subtle">
                × cada lámina del proyecto
                <span className="ml-1 inline-block animate-pulse">_</span>
              </p>

              {/* Slow manual export, to contrast with the 1-click side */}
              <div className="relative mt-10 rounded-xl border border-line bg-ink-2/60 p-4">
                <div className="flex items-center justify-between font-mono text-[11px] text-subtle">
                  <span>Exportación manual…</span>
                  <span>1 / 8</span>
                </div>
                <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-white/5">
                  <div className="manual-crawl h-full rounded-full bg-subtle/60" />
                </div>
                <p className="mt-2.5 text-xs text-faint">Revit ocupado · no puedes seguir modelando</p>
              </div>
            </Spotlight>
            <Spotlight className="flex flex-col bg-ink-2 p-8 sm:p-10">
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_85%_10%,rgba(59,130,246,0.3),transparent_55%),radial-gradient(circle_at_10%_100%,rgba(34,211,238,0.15),transparent_55%)]" />
              <p className="relative text-sm font-medium text-accent">Con BinFlow</p>
              <div className="relative mt-6">
                <motion.p
                  initial={{ opacity: 0, scale: 0.8, filter: 'blur(8px)' }}
                  whileInView={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                  viewport={{ once: true, margin: '-80px' }}
                  transition={{ type: 'spring', stiffness: 160, damping: 16, delay: 0.5 }}
                  className="text-brand origin-left text-5xl font-semibold tracking-[-0.04em] sm:text-6xl"
                >
                  1 clic.
                </motion.p>
                <p className="mt-4 max-w-xs text-muted">Todo el set exportado, con formato correcto y nombres listos para entregar.</p>
              </div>
            </Spotlight>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="proceso" className="relative overflow-hidden border-t border-line py-24 sm:py-32">
        <PlanDrawing loop className="pointer-events-none absolute top-1/2 left-1/2 w-[680px] max-w-none -translate-x-1/2 -translate-y-1/2 opacity-[0.16] sm:w-[860px]" />
        <div className="relative mx-auto max-w-6xl px-5 sm:px-8">
          <Reveal className="text-center">
            <Eyebrow>Cómo funciona</Eyebrow>
            <h2 className="mt-5 text-3xl font-semibold tracking-[-0.03em] text-white sm:text-5xl">Tres pasos. Una sola vez.</h2>
          </Reveal>

          <div ref={stepsRef} className="relative mt-20 grid gap-14 md:grid-cols-3 md:gap-10">
            <div className="absolute top-5 right-[16%] left-[16%] hidden h-px bg-white/5 md:block" />
            <motion.div
              style={{ scaleX: stepsLine }}
              className="absolute top-5 right-[16%] left-[16%] hidden h-0.5 origin-left bg-gradient-to-r from-accent via-accent-2 to-accent md:block"
            />
            {[
              { t: 'Elige el set', d: 'Selecciona las láminas de Revit: una disciplina o el proyecto completo.' },
              { t: 'Define la regla', d: 'Configura tu nomenclatura una vez y reutilízala en cada entrega.', code: 'A-101_Planta_R03.pdf' },
              { t: 'Exporta', d: 'BinFlow genera los PDFs vectoriales en segundo plano, ordenados en carpetas.' },
            ].map((s, i) => (
              <Reveal key={s.t} delay={i * 0.15} className="group relative text-center">
                <span className="relative mx-auto flex h-10 w-10 items-center justify-center rounded-full border border-accent/40 bg-ink font-mono text-sm text-accent transition-all duration-300 group-hover:scale-110 group-hover:border-transparent group-hover:bg-gradient-to-br group-hover:from-accent group-hover:to-accent-2 group-hover:text-ink">
                  <span className="absolute inset-0 animate-ping rounded-full border border-accent/30 [animation-duration:2.4s]" />
                  {i + 1}
                </span>
                <h3 className="mt-6 text-xl font-semibold text-white">{s.t}</h3>
                <p className="mx-auto mt-3 max-w-xs leading-relaxed text-muted">{s.d}</p>
                {s.code && (
                  <code className="mt-4 inline-block rounded-md border border-line px-2.5 py-1 font-mono text-xs text-accent">
                    {s.code}
                  </code>
                )}
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Photo band with parallax */}
      <section ref={bandRef} className="relative overflow-hidden border-t border-line">
        <motion.div
          style={{ y: bandY }}
          className="media pointer-events-none absolute inset-x-0 -top-[12%] -bottom-[12%]"
          aria-hidden="true"
        >
          <BrandImage image={brandImages.architect} decorative className="object-[75%_center]" />
        </motion.div>
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-ink via-ink/80 to-ink/20" />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink/80 via-transparent to-transparent" />
        <div className="relative z-10 mx-auto flex max-w-6xl flex-col gap-8 px-5 py-20 sm:px-8 sm:py-24 md:flex-row md:items-end md:justify-between">
          <Reveal>
            <p className="max-w-2xl text-3xl leading-tight font-semibold tracking-[-0.03em] text-white sm:text-5xl">
              Menos tiempo exportando.
              <br />
              <span className="text-brand">Más tiempo diseñando.</span>
            </p>
            <ul className="mt-6 flex flex-wrap gap-2">
              {['Detección de formato', 'Nombres automáticos', 'Segundo plano', '100% local'].map((t) => (
                <li key={t} className="rounded-full border border-white/15 bg-ink/50 px-3 py-1.5 text-xs text-muted backdrop-blur">
                  {t}
                </li>
              ))}
            </ul>
          </Reveal>
          <Reveal delay={0.1}>
            <a
              href="#contacto"
              className="btn-brand group inline-flex shrink-0 items-center gap-2 overflow-hidden rounded-full px-6 py-3 font-semibold"
            >
              <span className="relative">Ver BinFlow en acción</span>
              <ArrowRight className="relative h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </a>
          </Reveal>
        </div>
      </section>

      {/* Product + demo */}
      <section className="surface-raised relative overflow-hidden border-t border-line py-24 sm:py-32">
        <div className="pointer-events-none absolute top-1/2 right-0 h-[520px] w-[620px] -translate-y-1/2 rounded-full bg-blue-600/15 blur-[140px]" />
        <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-5 sm:px-8 lg:grid-cols-2 lg:gap-20">
          <Reveal>
            <Eyebrow>En acción</Eyebrow>
            <h2 className="mt-5 text-3xl leading-tight font-semibold tracking-[-0.03em] text-white sm:text-5xl">
              Revit sigue libre mientras BinFlow trabaja.
            </h2>
            <ul className="mt-10 space-y-6">
              {[
                { icon: ScanLine, t: 'Detección de formato', d: 'A0, A1, ARCH D… sin márgenes cortados.' },
                { icon: FileSignature, t: 'Nombres automáticos', d: 'Según número, nombre y revisión.' },
                { icon: Cpu, t: 'Segundo plano', d: 'Sin congelar tu sesión de trabajo.' },
              ].map(({ icon: Icon, t, d }) => (
                <li key={t} className="group flex gap-4 transition-transform duration-300 hover:translate-x-1.5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line transition-colors duration-300 group-hover:border-accent/50 group-hover:bg-accent/10">
                    <Icon className="h-[18px] w-[18px] text-accent" strokeWidth={1.6} />
                  </span>
                  <div>
                    <p className="font-medium text-white">{t}</p>
                    <p className="mt-1 text-sm text-muted">{d}</p>
                  </div>
                </li>
              ))}
            </ul>

            {/* Benefit image: plans ready for review, model still open */}
            <figure className="media media-hover group relative mt-10 aspect-[16/9] rounded-2xl border border-line shadow-[0_30px_80px_-40px_rgba(34,211,238,0.35)] transition-colors duration-500 hover:border-accent/40">
              <BrandImage image={brandImages.review} sizes="(min-width: 1024px) 520px, 100vw" />
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink/85 via-ink/10 to-transparent" />
              <figcaption className="absolute inset-x-4 bottom-4 flex items-center justify-between gap-3 text-sm text-white">
                <span>Planos listos para revisar, sin exportar a mano.</span>
                <span className="hidden shrink-0 rounded-md border border-accent/40 bg-ink/70 px-2 py-1 font-mono text-[10px] text-accent backdrop-blur transition-colors group-hover:bg-accent group-hover:text-ink sm:inline">
                  PDF · listo
                </span>
              </figcaption>
            </figure>
          </Reveal>
          <Reveal delay={0.15}>
            <InteractiveWorkflowDemo />
          </Reveal>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="border-t border-line pt-24 pb-14 sm:pt-28 sm:pb-16">
        <div className="mx-auto grid max-w-6xl items-start gap-10 px-5 sm:px-8 lg:grid-cols-[1fr_1.6fr] lg:gap-20">
          <Reveal>
            <Eyebrow>FAQ</Eyebrow>
            <h2 className="mt-5 text-3xl font-semibold tracking-[-0.03em] text-white sm:text-4xl">Preguntas frecuentes</h2>
            <p className="mt-4 max-w-xs text-muted">Lo que suelen preguntar los equipos BIM antes de probar BinFlow.</p>
          </Reveal>
          <div>
          <div className="divide-y divide-line border-y border-line">
            {faqs.map((f, i) => {
              const open = openFaq === i;
              return (
                <div key={f.q}>
                  <button
                    onClick={() => setOpenFaq(open ? null : i)}
                    aria-expanded={open}
                    className="flex w-full cursor-pointer items-center justify-between gap-6 py-6 text-left"
                  >
                    <span className="text-base font-medium text-white sm:text-lg">{f.q}</span>
                    <Plus className={`h-5 w-5 shrink-0 text-subtle transition-transform duration-300 ${open ? 'rotate-45 text-accent' : ''}`} />
                  </button>
                  <AnimatePresence initial={false}>
                    {open && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                        className="overflow-hidden"
                      >
                        <p className="max-w-xl pb-6 leading-relaxed text-muted">{f.a}</p>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>

          {/* Bridge to the CTA */}
          <a
            href="#contacto"
            className="group mt-8 flex items-center justify-between gap-4 rounded-2xl border border-line bg-ink-2/60 p-5 transition-colors hover:border-accent/50"
          >
            <span>
              <span className="block font-medium text-white">¿Tienes otra pregunta?</span>
              <span className="mt-1 block text-sm text-muted">La resolvemos en vivo durante la demo, con tus modelos.</span>
            </span>
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-accent/40 text-accent transition-all group-hover:translate-x-1 group-hover:bg-accent group-hover:text-ink">
              <ArrowRight className="h-4 w-4" />
            </span>
          </a>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section id="contacto" className="relative overflow-hidden border-t border-line py-20 sm:py-28">
        <div className="photo pointer-events-none absolute inset-0 opacity-40" aria-hidden="true">
          <img src={torres} alt="" loading="lazy" className="ken-burns" style={{ objectPosition: '50% 80%' }} />
        </div>
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-ink/80 via-ink/65 to-ink" />
        <div className="grid-fade pointer-events-none absolute inset-0" />
        <div className="pointer-events-none absolute bottom-[-200px] left-1/2 h-[460px] w-[820px] -translate-x-1/2 rounded-full bg-gradient-to-r from-cyan-500/25 to-blue-600/25 blur-[130px]" />
        <Reveal className="relative mx-auto max-w-2xl px-5 text-center sm:px-8">
          <h2 className="text-4xl leading-tight font-semibold tracking-[-0.04em] text-white sm:text-6xl">
            Deja de exportar <span className="text-brand">a mano.</span>
          </h2>
          <p className="mx-auto mt-5 max-w-md text-lg text-muted">Te mostramos BinFlow con tus propios modelos de Revit.</p>

          {sent ? (
            <p className="mx-auto mt-10 inline-flex items-center gap-2 rounded-full border border-accent/40 px-5 py-3 text-sm text-white">
              <Check className="h-4 w-4 text-accent" /> Recibido. Te escribiremos a {email}.
            </p>
          ) : (
            <form
              onSubmit={handleDemo}
              className="mx-auto mt-10 flex max-w-md flex-col gap-2 rounded-2xl border border-line bg-ink-2/80 p-2 backdrop-blur sm:flex-row sm:rounded-full"
            >
              <label htmlFor="email" className="sr-only">Correo electrónico</label>
              <input
                id="email"
                type="email"
                required
                placeholder="tu@estudio.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="min-w-0 flex-1 bg-transparent px-4 py-3 text-white placeholder-subtle outline-none"
              />
              <button
                type="submit"
                className="btn-brand cursor-pointer rounded-full px-6 py-3 font-semibold"
              >
                Solicitar demo
              </button>
            </form>
          )}
          <p className="mt-5 text-sm text-subtle">Demo personalizada · Sin compromiso</p>
        </Reveal>
      </section>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-5 py-8 text-sm text-subtle sm:flex-row sm:px-8">
          <Logo />
          <div className="text-center sm:text-right">
            <p>© 2026 BinFlow · Automatización de planos para Revit</p>
            <p className="mt-1">
              <a href="/portal/" className="underline-offset-4 hover:text-white hover:underline">Mi cuenta</a>
              {' · '}
              <a href="/portal/#comprar" className="underline-offset-4 hover:text-white hover:underline">Comprar licencia</a>
            </p>
            <p className="mt-1 text-xs text-faint">Fotografías: Wikimedia Commons (CC0 / dominio público)</p>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;
