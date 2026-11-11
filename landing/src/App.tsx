import { lazy, Suspense, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ArrowRight,
  BarChart3,
  Check,
  Clock,
  FileOutput,
  FolderArchive,
  HardDrive,
  Layers,
  Plus,
  RotateCw,
  ShieldCheck,
  SlidersHorizontal,
  Zap,
} from 'lucide-react';
import { BrandArt } from './components/BrandArt';
import { ExportShowcase } from './components/ExportShowcase';
import { PlanDrawing } from './components/PlanDrawing';
import { Pricing } from './components/Pricing';

// El escenario 3D (three.js) se descarga solo cuando el visitante llega a esa parte de la página.
const BimCanvas = lazy(() => import('./components/BimCanvas'));

const ease = [0.22, 1, 0.36, 1] as const;

function Reveal({ children, delay = 0, className = '' }: { children: ReactNode; delay?: number; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? false : { opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-70px' }}
      transition={{ duration: 0.7, ease, delay }}
    >
      {children}
    </motion.div>
  );
}

function Eyebrow({ children, light = false }: { children: ReactNode; light?: boolean }) {
  return (
    <p className={`text-xs font-semibold tracking-[0.28em] uppercase ${light ? 'text-[#4fd8df]' : 'text-brand-teal'}`}>{children}</p>
  );
}

const features = [
  { icon: Zap, title: 'Automatiza', text: 'tareas repetitivas' },
  { icon: Clock, title: 'Ahorra', text: 'tiempo de entrega' },
  { icon: BarChart3, title: 'Mejora', text: 'la productividad' },
  { icon: Layers, title: 'Integra', text: 'y exporta BIM' },
];

const benefits = [
  { icon: FileOutput, title: 'Todo el set en un clic', text: 'Láminas o vistas ordenadas por número de lámina, a PDF, DWG, DXF, PNG, JPG y TIFF.' },
  { icon: SlidersHorizontal, title: 'Control fino', text: 'Papel, escala, color, DPI, versión CAD y unidades. Guarda perfiles y reutilízalos en cada entrega.' },
  { icon: RotateCw, title: 'A prueba de fallos', text: 'Si una vista falla, las demás continúan. Reintentas solo lo fallido y recibes un reporte de todo el lote.' },
  { icon: ShieldCheck, title: 'Tu modelo intacto', text: 'Los ajustes temporales, como el nivel de detalle, se revierten al terminar, incluso si algo sale mal.' },
  { icon: FolderArchive, title: 'Entregas ordenadas', text: 'Una carpeta nueva por entrega, nombres sin colisiones, ZIP opcional y un reporte.csv de cada operación.' },
  { icon: HardDrive, title: '100% local', text: 'Tus archivos no salen de tu equipo. Solo la licencia se valida en línea, y funciona hasta 7 días sin conexión.' },
];

const steps = [
  { n: '01', title: 'Selecciona', text: 'Todas las láminas, todas las vistas imprimibles o una selección personalizada con búsqueda.' },
  { n: '02', title: 'Configura', text: 'Elige formatos, calidad y carpeta de destino, o carga un perfil guardado y listo.' },
  { n: '03', title: 'Exporta', text: 'Sigue el avance, cancela cuando quieras y recibe tu entrega con su reporte.' },
];

const before = ['Abrir cada lámina', 'Configurar la impresora', 'Ajustar el formato', 'Exportar', 'Renombrar el archivo'];

const faqs: { q: string; a: string; link?: { href: string; label: string } }[] = [
  { q: '¿Qué formatos y versiones de Revit soporta?', a: 'Exporta a PDF, DWG, DXF, PNG, JPG y TIFF, y hay una versión del plugin para Revit 2023, 2024, 2025, 2026 y 2027.' },
  { q: '¿Cómo funciona el mes gratuito?', a: 'Creas tu cuenta y confirmas tu correo. Recibes 30 días para una computadora, con una exportación al día y sin tarjeta. El cupo se renueva a medianoche de Perú. Es una prueba por cuenta y por equipo.' },
  { q: '¿Mis archivos salen de mi equipo?', a: 'No. La exportación ocurre en tu computadora. Lo único que viaja a internet es la validación de la licencia.' },
  { q: '¿Necesito internet para trabajar?', a: 'Solo para activar y para verificar la licencia. Si te quedas sin conexión puedes seguir trabajando hasta 7 días.' },
  { q: '¿En cuántos equipos puedo usarla?', a: 'Según tu plan. Desde tu cuenta puedes liberar un equipo para usarla en otro cuando cambies de computadora.' },
  {
    q: '¿Windows me muestra un aviso al instalar?',
    a: 'Con programas nuevos es normal: Windows pide confirmar antes de abrirlos. Se resuelve en un par de clics y te explicamos cada aviso paso a paso.',
    link: { href: '/instalacion/', label: 'Ver la guía de instalación' },
  },
  { q: '¿Cómo pago y cómo recibo mi licencia?', a: 'Eliges tu plan en tu cuenta y haces el pedido. Cuando se confirma el pago, tu clave aparece en tu panel y puedes renovar desde ahí cuando quieras.' },
];

export function App() {
  const reduce = useReducedMotion();
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  const handleDemo = (e: React.FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!value) return;
    setSent(true);
    // La solicitud llega al panel de administración (Actividad).
    fetch('/portal/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'bimflow' },
      body: JSON.stringify({ email: value }),
    }).catch(() => {});
  };

  const float = (delay: number) =>
    reduce ? {} : { animate: { y: [0, -9, 0] }, transition: { duration: 5.5, repeat: Infinity, ease: 'easeInOut' as const, delay } };

  return (
    <div className="min-h-screen bg-white text-navy">
      {/* Encabezado */}
      <header className="sticky top-0 z-50 border-b border-slate-200/70 bg-white/85 backdrop-blur-xl">
        <div className="mx-auto flex h-[76px] max-w-6xl items-center justify-between gap-4 px-5 sm:px-8">
          <a href="#" aria-label="BIM FLOW by Vertex, inicio" className="shrink-0">
            <img src="/brand/logo-header.png" alt="BIM FLOW by Vertex" width={760} height={226} className="h-11 w-auto sm:h-[52px]" />
          </a>
          <nav className="hidden items-center gap-9 text-sm font-medium text-slate-600 md:flex" aria-label="Secciones">
            <a href="#beneficios" className="transition-colors hover:text-brand">Beneficios</a>
            <a href="#proceso" className="transition-colors hover:text-brand">Cómo funciona</a>
            <a href="#precios" className="transition-colors hover:text-brand">Precios</a>
            <a href="#faq" className="transition-colors hover:text-brand">Preguntas</a>
          </nav>
          <div className="flex items-center gap-4">
            <a href="/portal/" className="hidden text-sm font-semibold text-brand transition-colors hover:text-navy sm:inline">Mi cuenta</a>
            <a href="/portal/#comprar" className="btn-primary rounded-full px-5 py-2.5 text-sm font-bold whitespace-nowrap">Probar gratis</a>
          </div>
        </div>
      </header>

      <main>
        {/* Héroe */}
        <section className="relative overflow-hidden bg-gradient-to-b from-white via-white to-mist">
          <BrandArt />
          <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-5 pt-16 pb-20 sm:px-8 lg:grid-cols-[1.05fr_0.95fr] lg:pt-24 lg:pb-28">
            <div>
              <Reveal>
                <Eyebrow>Plugins para ingeniería y arquitectura</Eyebrow>
              </Reveal>
              <Reveal delay={0.08}>
                <h1 className="mt-5 text-balance text-[2.6rem] leading-[1.04] font-extrabold tracking-tight sm:text-6xl lg:text-[4.1rem]">
                  Más eficiencia,
                  <br />
                  <span className="text-gradient">más proyectos</span>
                </h1>
              </Reveal>
              <Reveal delay={0.16}>
                <p className="mt-6 max-w-xl text-lg leading-relaxed text-slate-600">
                  BIM FLOW desarrolla plugins que automatizan lo repetitivo en Revit. Con <b className="text-navy">XportBIM</b> exportas todo el set de láminas o vistas a PDF, DWG, DXF e imágenes en un solo clic.
                </p>
              </Reveal>
              <Reveal delay={0.24}>
                <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
                  <a href="/portal/#comprar" className="btn-primary inline-flex items-center justify-center gap-2 rounded-full px-7 py-3.5 font-bold">
                    Probar gratis 7 días
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </a>
                  <a
                    href="#proceso"
                    className="inline-flex items-center justify-center rounded-full border border-brand/25 bg-white px-7 py-3.5 font-bold text-brand transition-colors hover:border-brand hover:bg-brand/5"
                  >
                    Ver cómo funciona
                  </a>
                </div>
                <p className="mt-4 text-sm text-slate-500">Sin tarjeta · Todas las funciones · Para Revit 2023 a 2027</p>
              </Reveal>
            </div>

            <Reveal delay={0.2} className="relative">
              <div className="relative">
                <div className="overflow-hidden rounded-[28px] border border-white/60 shadow-[0_40px_90px_-35px_rgba(3,26,53,0.55)] ring-1 ring-slate-900/5">
                  <img
                    src="/images/hero-revit.jpg"
                    srcSet="/images/hero-revit-960.jpg 960w, /images/hero-revit.jpg 1672w"
                    sizes="(min-width: 1024px) 520px, 90vw"
                    width={1672}
                    height={941}
                    alt="Estación de trabajo con un modelo BIM en 3D y su planta en Revit"
                    fetchPriority="high"
                    className="aspect-[4/3.2] w-full object-cover"
                  />
                </div>
                <motion.div {...float(0)} className="absolute -top-5 -left-3 rounded-2xl border border-white/70 bg-white/95 px-4 py-3 shadow-xl backdrop-blur sm:-left-8">
                  <p className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">Exportando</p>
                  <p className="mt-0.5 text-sm font-bold text-navy">18 de 24 láminas</p>
                  <div className="mt-2 h-1.5 w-36 overflow-hidden rounded-full bg-slate-200">
                    <div className="h-full w-3/4 rounded-full bg-gradient-to-r from-brand to-brand-teal" />
                  </div>
                </motion.div>
                <motion.div {...float(1.2)} className="absolute -right-3 -bottom-6 flex items-center gap-3 rounded-2xl border border-white/70 bg-white/95 px-4 py-3 shadow-xl backdrop-blur sm:-right-6">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-teal/15">
                    <Check className="h-5 w-5 text-brand-teal" strokeWidth={3} aria-hidden="true" />
                  </span>
                  <span>
                    <span className="block text-sm font-bold text-navy">PDF · DWG · DXF</span>
                    <span className="block text-xs text-slate-500">Entrega lista con reporte</span>
                  </span>
                </motion.div>
              </div>
            </Reveal>
          </div>

          {/* Cuatro ideas */}
          <div className="relative mx-auto max-w-6xl px-5 pb-14 sm:px-8">
            <ul className="grid grid-cols-2 gap-y-8 border-t border-slate-200/70 pt-10 md:grid-cols-4">
              {features.map(({ icon: Icon, title, text }) => (
                <li key={title} className="flex flex-col items-center text-center">
                  <span className="flex h-14 w-14 items-center justify-center rounded-full bg-brand/[0.08] text-brand">
                    <Icon className="h-6 w-6" aria-hidden="true" />
                  </span>
                  <span className="mt-3 text-sm font-bold">{title}</span>
                  <span className="text-sm text-slate-500">{text}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Compatibilidad */}
        <section aria-label="Compatibilidad" className="border-y border-slate-200/70 bg-white">
          <div className="mx-auto flex max-w-6xl flex-col items-center justify-center gap-4 px-5 py-7 sm:px-8 md:flex-row md:gap-8">
            <p className="text-sm font-medium whitespace-nowrap text-slate-500">Compatible con Autodesk Revit</p>
            <ul className="flex flex-wrap items-center justify-center gap-2.5">
              {['2023', '2024', '2025', '2026', '2027'].map((y) => (
                <li key={y} className="rounded-full border border-brand/20 bg-brand/[0.05] px-4 py-1.5 text-sm font-bold whitespace-nowrap text-brand">
                  Revit {y}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Beneficios */}
        <section id="beneficios" className="bg-gradient-to-b from-white to-mist/60 py-24 sm:py-28">
          <div className="mx-auto max-w-6xl px-5 sm:px-8">
            <div className="max-w-2xl">
              <Reveal>
                <Eyebrow>Soluciones que se adaptan a tu flujo</Eyebrow>
                <h2 className="mt-4 text-balance text-3xl leading-tight font-extrabold tracking-tight sm:text-[2.6rem]">
                  Exportar planos ya no debería <span className="text-gradient">quitarte horas</span>
                </h2>
                <p className="mt-5 text-lg text-slate-600">XportBIM resuelve la entrega de planos de principio a fin, con el control que necesita un proyecto real.</p>
              </Reveal>
            </div>
            <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {benefits.map(({ icon: Icon, title, text }, i) => (
                <Reveal key={title} delay={(i % 3) * 0.08}>
                  <article className="h-full rounded-3xl border border-slate-200/80 bg-white p-7 shadow-[0_18px_40px_-28px_rgba(3,26,53,0.35)] transition-shadow hover:shadow-[0_26px_50px_-26px_rgba(0,91,174,0.4)]">
                    <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-brand/10 to-brand-teal/15 text-brand">
                      <Icon className="h-6 w-6" aria-hidden="true" />
                    </span>
                    <h3 className="mt-5 text-lg font-bold">{title}</h3>
                    <p className="mt-2 leading-relaxed text-slate-600">{text}</p>
                  </article>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* Cómo funciona */}
        <section id="proceso" className="bg-mist/60 pb-24 sm:pb-28">
          <div className="mx-auto max-w-6xl px-5 sm:px-8">
            <Reveal className="mx-auto max-w-2xl text-center">
              <Eyebrow>Cómo funciona</Eyebrow>
              <h2 className="mt-4 text-balance text-3xl font-extrabold tracking-tight sm:text-[2.6rem]">Tres pasos y tu entrega está lista</h2>
            </Reveal>
            <ol className="mt-14 grid gap-6 md:grid-cols-3">
              {steps.map((s, i) => (
                <Reveal key={s.n} delay={i * 0.1}>
                  <li className="relative h-full list-none rounded-3xl border border-white bg-white/80 p-8 shadow-[0_18px_40px_-30px_rgba(3,26,53,0.4)]">
                    <span className="text-gradient text-5xl font-extrabold tracking-tight">{s.n}</span>
                    <h3 className="mt-4 text-xl font-bold">{s.title}</h3>
                    <p className="mt-2 leading-relaxed text-slate-600">{s.text}</p>
                  </li>
                </Reveal>
              ))}
            </ol>
          </div>
        </section>

        {/* Productividad (sección oscura) */}
        <section className="relative overflow-hidden bg-navy py-24 text-white sm:py-28">
          <div className="blueprint pointer-events-none absolute inset-0" aria-hidden="true" />
          <div className="pointer-events-none absolute -top-40 right-[-10%] h-[520px] w-[520px] rounded-full bg-brand/30 blur-[130px]" aria-hidden="true" />
          <div className="pointer-events-none absolute bottom-[-180px] left-[-8%] h-[420px] w-[420px] rounded-full bg-brand-teal/20 blur-[130px]" aria-hidden="true" />
          <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-5 sm:px-8 lg:grid-cols-2">
            <Reveal>
              <Eyebrow light>Mejora tu productividad</Eyebrow>
              <h2 className="mt-4 text-balance text-3xl leading-tight font-extrabold tracking-tight sm:text-[2.6rem]">
                Del primer clic al set completo, <span className="text-gradient-light">sin repetir pasos</span>
              </h2>
              <div className="mt-9 grid gap-4 sm:grid-cols-2">
                <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-5">
                  <p className="text-xs font-semibold tracking-[0.2em] text-slate-400 uppercase">Antes, por cada lámina</p>
                  <ul className="mt-3 grid gap-2 text-sm text-slate-300">
                    {before.map((b) => (
                      <li key={b} className="flex items-center gap-2.5 line-through decoration-slate-500">
                        <span className="h-1.5 w-1.5 rounded-full bg-slate-500" aria-hidden="true" />
                        {b}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="rounded-2xl border border-brand-teal/40 bg-brand-teal/[0.07] p-5">
                  <p className="text-xs font-semibold tracking-[0.2em] text-[#4fd8df] uppercase">Con BIM FLOW</p>
                  <ul className="mt-3 grid gap-2 text-sm text-white">
                    {['Seleccionas las láminas', 'Pulsas Exportar'].map((b) => (
                      <li key={b} className="flex items-center gap-2.5">
                        <Check className="h-4 w-4 text-[#4fd8df]" strokeWidth={3} aria-hidden="true" />
                        {b}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-4 text-sm text-slate-300">Y recibes la entrega ordenada, con su reporte.</p>
                </div>
              </div>
              <dl className="mt-9 grid grid-cols-3 gap-4 border-t border-white/10 pt-7">
                {[
                  ['6', 'formatos de salida'],
                  ['5', 'versiones de Revit'],
                  ['0', 'archivos en la nube'],
                ].map(([n, l]) => (
                  <div key={l}>
                    <dt className="text-3xl font-extrabold text-white">{n}</dt>
                    <dd className="mt-1 text-sm text-slate-400">{l}</dd>
                  </div>
                ))}
              </dl>
            </Reveal>
            <Reveal delay={0.12}>
              <ExportShowcase />
            </Reveal>
          </div>

          {/* Escenario 3D interactivo */}
          <div className="relative mx-auto mt-24 max-w-6xl px-5 sm:px-8">
            <Reveal className="mx-auto max-w-2xl text-center">
              <Eyebrow light>Míralo en 3D</Eyebrow>
              <h3 className="mt-4 text-3xl leading-tight font-extrabold tracking-tight text-balance sm:text-4xl">
                Cada lámina viaja a su lugar. <span className="text-gradient-light">Pruébalo.</span>
              </h3>
              <p className="mt-4 text-slate-300">Pulsa <b className="text-white">Exportar set</b> y mira cómo se arma la entrega. Puedes pasar el cursor para acelerar el flujo.</p>
            </Reveal>
            <Reveal delay={0.1}>
              <div className="relative mt-10 h-[420px] overflow-hidden rounded-[28px] border border-white/10 bg-gradient-to-b from-white/[0.04] to-transparent sm:h-[520px]">
                <PlanDrawing loop className="pointer-events-none absolute top-1/2 left-1/2 w-[680px] max-w-none -translate-x-1/2 -translate-y-1/2 opacity-[0.14] sm:w-[860px]" />
                <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-slate-400">Cargando escena 3D…</div>}>
                  <BimCanvas />
                </Suspense>
              </div>
            </Reveal>
          </div>
        </section>

        {/* Precios */}
        <section id="precios" className="bg-gradient-to-b from-mist/60 to-white py-24 sm:py-28">
          <div className="mx-auto max-w-6xl px-5 sm:px-8">
            <Reveal className="mx-auto mb-12 max-w-2xl text-center">
              <Eyebrow>Precios</Eyebrow>
              <h2 className="mt-4 text-balance text-3xl font-extrabold tracking-tight sm:text-[2.6rem]">Empieza gratis. Paga cuando te convenza.</h2>
              <p className="mt-4 text-lg text-slate-600">7 días con todas las funciones. Después eliges el plan que mejor se ajuste a tu equipo.</p>
            </Reveal>
            <Pricing />
          </div>
        </section>

        {/* Preguntas */}
        <section id="faq" className="pb-24 sm:pb-28">
          <div className="mx-auto max-w-3xl px-5 sm:px-8">
            <Reveal className="text-center">
              <Eyebrow>Preguntas frecuentes</Eyebrow>
              <h2 className="mt-4 text-balance text-3xl font-extrabold tracking-tight sm:text-4xl">Lo que suelen preguntarnos</h2>
            </Reveal>
            <div className="mt-10 divide-y divide-slate-200 rounded-3xl border border-slate-200 bg-white px-6">
              {faqs.map((f, i) => {
                const open = openFaq === i;
                return (
                  <div key={f.q}>
                    <h3>
                      <button
                        type="button"
                        aria-expanded={open}
                        aria-controls={`faq-${i}`}
                        onClick={() => setOpenFaq(open ? null : i)}
                        className="flex w-full cursor-pointer items-center justify-between gap-4 py-5 text-left font-semibold"
                      >
                        {f.q}
                        <motion.span animate={{ rotate: open ? 45 : 0 }} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand/[0.08] text-brand">
                          <Plus className="h-4 w-4" aria-hidden="true" />
                        </motion.span>
                      </button>
                    </h3>
                    <AnimatePresence initial={false}>
                      {open && (
                        <motion.div
                          id={`faq-${i}`}
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.3, ease }}
                          className="overflow-hidden"
                        >
                          <p className="pb-5 leading-relaxed text-slate-600">
                            {f.a}
                            {f.link && (
                              <>
                                {' '}
                                <a href={f.link.href} className="font-semibold text-brand underline-offset-4 hover:underline">{f.link.label}</a>
                              </>
                            )}
                          </p>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* Llamado final */}
        <section className="relative overflow-hidden bg-navy py-20 text-white sm:py-24">
          <div className="blueprint pointer-events-none absolute inset-0" aria-hidden="true" />
          <div className="pointer-events-none absolute bottom-[-220px] left-1/2 h-[460px] w-[820px] -translate-x-1/2 rounded-full bg-gradient-to-r from-brand-teal/25 to-brand/30 blur-[130px]" aria-hidden="true" />
          <Reveal className="relative mx-auto max-w-2xl px-5 text-center sm:px-8">
            <h2 className="text-4xl leading-tight font-extrabold tracking-tight sm:text-5xl">
              Deja de exportar <span className="text-gradient-light">a mano.</span>
            </h2>
            <p className="mx-auto mt-5 max-w-md text-lg text-slate-300">Pruébalo 7 días con todas tus láminas. Sin tarjeta.</p>
            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a href="/portal/#comprar" className="btn-primary inline-flex items-center justify-center gap-2 rounded-full px-8 py-3.5 font-bold">
                Empezar prueba gratis
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </a>
            </div>
            <div className="mx-auto mt-12 max-w-md border-t border-white/10 pt-8">
              <p className="text-sm text-slate-300">¿Prefieres verlo en acción? Te mostramos BIM FLOW con tus propios modelos.</p>
              {sent ? (
                <p className="mt-5 inline-flex items-center gap-2 rounded-full border border-brand-teal/50 px-5 py-3 text-sm text-white" role="status">
                  <Check className="h-4 w-4 text-[#4fd8df]" aria-hidden="true" /> Recibido. Te escribiremos a {email}.
                </p>
              ) : (
                <form onSubmit={handleDemo} className="mt-5 flex flex-col gap-2 rounded-2xl border border-white/15 bg-white/[0.06] p-2 sm:flex-row sm:rounded-full">
                  <label htmlFor="demo-email" className="sr-only">Correo electrónico</label>
                  <input
                    id="demo-email"
                    type="email"
                    required
                    placeholder="tu@estudio.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="min-w-0 flex-1 bg-transparent px-4 py-3 text-white placeholder-slate-400 outline-none"
                  />
                  <button type="submit" className="cursor-pointer rounded-full bg-white px-6 py-3 font-bold text-navy transition-colors hover:bg-mist">
                    Solicitar demo
                  </button>
                </form>
              )}
            </div>
          </Reveal>
        </section>
      </main>

      <footer className="bg-navy text-slate-400">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-5 border-t border-white/10 px-5 py-8 text-sm sm:flex-row sm:px-8">
          <img src="/brand/logo-header-white.png" alt="BIM FLOW by Vertex" width={760} height={226} className="h-9 w-auto" loading="lazy" />
          <nav className="flex items-center gap-6" aria-label="Enlaces del pie">
            <a href="#precios" className="transition-colors hover:text-white">Precios</a>
            <a href="/instalacion/" className="transition-colors hover:text-white">Instalación</a>
            <a href="/portal/" className="transition-colors hover:text-white">Mi cuenta</a>
            <a href="#faq" className="transition-colors hover:text-white">Preguntas</a>
          </nav>
          <p>© 2026 BIM FLOW · By Vertex</p>
        </div>
      </footer>
    </div>
  );
}

export default App;
