import { useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { AnimatePresence, motion } from 'motion/react';
import { Zap } from 'lucide-react';
import * as THREE from 'three';

const CYAN = '#22d3ee';
const NAVY = '#0b1a33';
const SHEETS = 7;
const LEVELS = 7;
const LEVEL_H = 0.36;
const BURST_SPEED = 6;

const reducedMotion =
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Shared, mutable animation state (no React re-renders per frame). */
type Flow = { time: number; speed: number; burst: number; pulse: number; hover: number };
type FlowRef = MutableRefObject<Flow>;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Draws a simple sheet (title block + floor plan) on a canvas texture. */
function makeSheetTexture(variant: 'blueprint' | 'paper') {
  const w = 512;
  const h = 360;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const bg = variant === 'blueprint' ? '#071a33' : '#f5f8fc';
  const ink = variant === 'blueprint' ? CYAN : NAVY;
  const soft = variant === 'blueprint' ? 'rgba(34,211,238,0.35)' : 'rgba(11,26,51,0.25)';

  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.strokeStyle = ink;
  g.lineWidth = 4;
  g.strokeRect(16, 16, w - 32, h - 32);

  g.lineWidth = 2;
  g.strokeRect(w - 128, 16, 112, h - 32);
  for (let y = 60; y < h - 40; y += 34) {
    g.beginPath();
    g.moveTo(w - 128, y);
    g.lineTo(w - 16, y);
    g.stroke();
  }
  g.fillStyle = CYAN;
  g.fillRect(w - 116, h - 64, 88, 30);

  g.strokeStyle = ink;
  g.lineWidth = 5;
  g.strokeRect(52, 52, 300, 250);
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(52, 170);
  g.lineTo(220, 170);
  g.moveTo(220, 52);
  g.lineTo(220, 302);
  g.moveTo(220, 230);
  g.lineTo(352, 230);
  g.stroke();

  g.strokeStyle = soft;
  g.lineWidth = 1.5;
  for (let x = 52; x <= 352; x += 50) {
    g.beginPath();
    g.moveTo(x, 36);
    g.lineTo(x, 46);
    g.stroke();
  }
  g.beginPath();
  g.moveTo(52, 41);
  g.lineTo(352, 41);
  g.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function Building({ flow }: { flow: FlowRef }) {
  const group = useRef<THREE.Group>(null);
  const scan = useRef<THREE.Group>(null);
  const total = LEVELS * LEVEL_H;
  const base = useMemo(() => new THREE.Color(CYAN), []);
  const white = useMemo(() => new THREE.Color('#ffffff'), []);

  const { slab, slabEdges, shellEdges, lineMat, coreMat } = useMemo(() => {
    const slab = new THREE.BoxGeometry(2.2, 0.04, 1.5);
    return {
      slab,
      slabEdges: new THREE.EdgesGeometry(slab),
      shellEdges: new THREE.EdgesGeometry(new THREE.BoxGeometry(2.2, total, 1.5)),
      lineMat: new THREE.LineBasicMaterial({ color: CYAN, transparent: true, opacity: 0.85 }),
      coreMat: new THREE.MeshStandardMaterial({
        color: '#0e2a4f',
        emissive: '#3b82f6',
        emissiveIntensity: 0.12,
        metalness: 0.8,
        roughness: 0.25,
      }),
    };
  }, [total]);

  useFrame((_, delta) => {
    const f = flow.current;
    const energy = Math.min(1, (f.speed - 1) / (BURST_SPEED - 1) + f.hover * 0.35);
    lineMat.color.copy(base).lerp(white, energy * 0.6);
    coreMat.emissiveIntensity = 0.12 + energy * 0.6;
    if (reducedMotion) return;
    if (group.current) group.current.rotation.y += delta * 0.1 * f.speed;
    if (scan.current) {
      const p = (f.time * 2.6) % 1;
      scan.current.position.y = p * total - total / 2;
      scan.current.scale.setScalar(1 + Math.sin(p * Math.PI) * 0.04);
    }
  });

  return (
    <group ref={group} rotation={[0, 0.6, 0]}>
      {Array.from({ length: LEVELS + 1 }, (_, i) => (
        <group key={i} position={[0, i * LEVEL_H - total / 2, 0]}>
          <mesh geometry={slab}>
            <meshStandardMaterial color={NAVY} transparent opacity={0.55} metalness={0.6} roughness={0.3} />
          </mesh>
          <lineSegments geometry={slabEdges} material={lineMat} />
        </group>
      ))}

      <lineSegments geometry={shellEdges}>
        <lineBasicMaterial color={CYAN} transparent opacity={0.25} />
      </lineSegments>

      <mesh material={coreMat}>
        <boxGeometry args={[0.5, total, 0.5]} />
      </mesh>

      <group ref={scan}>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[2.7, 2]} />
          <meshBasicMaterial color={CYAN} transparent opacity={0.07} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
        <lineSegments rotation={[-Math.PI / 2, 0, 0]}>
          <edgesGeometry args={[new THREE.PlaneGeometry(2.7, 2)]} />
          <lineBasicMaterial color={CYAN} transparent opacity={0.6} />
        </lineSegments>
      </group>
    </group>
  );
}

/** A sheet that leaves the model as a blueprint and lands on the stack as a PDF. */
function FlowingSheet({
  index,
  blueprint,
  paper,
  flow,
  onLand,
}: {
  index: number;
  blueprint: THREE.Texture;
  paper: THREE.Texture;
  flow: FlowRef;
  onLand: () => void;
}) {
  const ref = useRef<THREE.Group>(null);
  const bpMat = useRef<THREE.MeshBasicMaterial>(null);
  const paperMat = useRef<THREE.MeshBasicMaterial>(null);
  const edgeMat = useRef<THREE.LineBasicMaterial>(null);
  const last = useRef(-1);

  const curve = useMemo(() => {
    const y = -0.7 + (index % 4) * 0.4;
    return new THREE.CatmullRomCurve3([
      new THREE.Vector3(-1.2, y, 0.4),
      new THREE.Vector3(0.1, y + 0.9, 1.1),
      new THREE.Vector3(1.4, 0.4, 0.9),
      new THREE.Vector3(2.3, -0.85, 0.4),
    ]);
  }, [index]);

  const edges = useMemo(() => new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 0.7)), []);

  useFrame(() => {
    const t = reducedMotion ? 0.35 : flow.current.time;
    const p = (t + index / SHEETS) % 1;
    if (last.current > 0.5 && p < 0.5) onLand();
    last.current = p;

    const g = ref.current;
    if (!g) return;
    g.position.copy(curve.getPoint(p));
    const land = smooth(0.55, 1, p);
    g.rotation.set(THREE.MathUtils.lerp(0.05, -Math.PI / 2 + 0.05, land), THREE.MathUtils.lerp(0.5, 0, land), 0);
    g.scale.setScalar(THREE.MathUtils.lerp(0.55, 0.95, smooth(0, 0.6, p)));

    const alpha = smooth(0, 0.08, p) * (1 - smooth(0.9, 1, p));
    const k = smooth(0.35, 0.55, p);
    if (bpMat.current) bpMat.current.opacity = alpha * (1 - k);
    if (paperMat.current) paperMat.current.opacity = alpha * k;
    if (edgeMat.current) edgeMat.current.opacity = alpha * 0.9;
  });

  return (
    <group ref={ref}>
      <mesh>
        <planeGeometry args={[1, 0.7]} />
        <meshBasicMaterial ref={bpMat} map={blueprint} transparent side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <mesh position={[0, 0, 0.001]}>
        <planeGeometry args={[1, 0.7]} />
        <meshBasicMaterial ref={paperMat} map={paper} transparent side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <lineSegments geometry={edges}>
        <lineBasicMaterial ref={edgeMat} color={CYAN} transparent />
      </lineSegments>
    </group>
  );
}

/** Neat stack of exported PDFs, with a ripple each time a sheet lands. */
function PdfStack({ paper, flow }: { paper: THREE.Texture; flow: FlowRef }) {
  const glow = useRef<THREE.MeshBasicMaterial>(null);
  const ripple = useRef<THREE.Mesh>(null);
  const rippleMat = useRef<THREE.MeshBasicMaterial>(null);

  useFrame((state, delta) => {
    const f = flow.current;
    f.pulse = Math.max(0, f.pulse - delta * 1.8);
    if (glow.current) {
      glow.current.opacity = 0.16 + (reducedMotion ? 0 : Math.sin(state.clock.elapsedTime * 1.6) * 0.05) + f.pulse * 0.15;
    }
    if (ripple.current && rippleMat.current) {
      ripple.current.scale.setScalar(1 + (1 - f.pulse) * 0.6);
      rippleMat.current.opacity = f.pulse * 0.7;
    }
  });

  return (
    <group position={[2.3, -1, 0.4]}>
      {Array.from({ length: 6 }, (_, i) => (
        <mesh key={i} position={[0, i * 0.025, 0]} rotation={[-Math.PI / 2 + 0.05, 0, (i % 2 ? 1 : -1) * 0.015 * i]}>
          <planeGeometry args={[0.95, 0.665]} />
          <meshBasicMaterial map={paper} color={i === 5 ? '#ffffff' : '#c9d6e6'} />
        </mesh>
      ))}
      <mesh position={[0, -0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.9, 48]} />
        <meshBasicMaterial ref={glow} color={CYAN} transparent opacity={0.16} depthWrite={false} />
      </mesh>
      <mesh ref={ripple} position={[0, -0.015, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.86, 0.9, 64]} />
        <meshBasicMaterial ref={rippleMat} color={CYAN} transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
}

function Scene({ flow, onLand }: { flow: FlowRef; onLand: () => void }) {
  const root = useRef<THREE.Group>(null);
  const { viewport } = useThree();
  const scale = Math.min(1, viewport.width / 7.4);
  const { blueprint, paper } = useMemo(
    () => ({ blueprint: makeSheetTexture('blueprint'), paper: makeSheetTexture('paper') }),
    [],
  );

  useFrame((state, delta) => {
    const f = flow.current;
    const dt = Math.min(delta, 0.1);
    f.burst = Math.max(0, f.burst - dt);
    const target = f.burst > 0 ? BURST_SPEED : 1 + f.hover * 0.6;
    f.speed = THREE.MathUtils.lerp(f.speed, target, 1 - Math.exp(-dt * 3));
    f.time += dt * 0.07 * f.speed;

    if (!root.current || reducedMotion) return;
    const { x, y } = state.pointer;
    const reach = 0.12 + f.hover * 0.08;
    root.current.rotation.y = THREE.MathUtils.lerp(root.current.rotation.y, x * reach, 0.05);
    root.current.rotation.x = THREE.MathUtils.lerp(root.current.rotation.x, -y * 0.06, 0.05);
    root.current.position.y = Math.sin(state.clock.elapsedTime * 0.6) * 0.05;
  });

  const land = () => {
    flow.current.pulse = 1;
    onLand();
  };

  return (
    <group ref={root} scale={scale} position={[-0.4 * scale, 0, 0]}>
      <group position={[-1.2, 0, 0]}>
        <Building flow={flow} />
      </group>
      {Array.from({ length: SHEETS }, (_, i) => (
        <FlowingSheet key={i} index={i} blueprint={blueprint} paper={paper} flow={flow} onLand={land} />
      ))}
      <PdfStack paper={paper} flow={flow} />
    </group>
  );
}

export function BimCanvas() {
  const flow = useRef<Flow>({ time: 0, speed: 1, burst: 0, pulse: 0, hover: 0 });
  const [count, setCount] = useState(0);
  const [boosting, setBoosting] = useState(false);

  const boost = () => {
    flow.current.burst = 2.2;
    setBoosting(true);
    window.setTimeout(() => setBoosting(false), 2200);
  };

  return (
    <div
      className="group relative h-full w-full cursor-pointer select-none"
      onPointerEnter={() => (flow.current.hover = 1)}
      onPointerLeave={() => (flow.current.hover = 0)}
      onClick={boost}
    >
      <Canvas
        dpr={[1, 2]}
        camera={{ position: [0.6, 2.2, 7.2], fov: 36 }}
        gl={{ antialias: true, alpha: true }}
        onCreated={({ camera }) => camera.lookAt(0.4, -0.2, 0)}
        aria-hidden="true"
      >
        <ambientLight intensity={0.7} />
        <directionalLight position={[6, 8, 5]} intensity={1.6} color="#cffafe" />
        <pointLight position={[-4, -2, 3]} intensity={10} color="#3b82f6" distance={10} />
        <pointLight position={[4, -1, 2]} intensity={6} color={CYAN} distance={8} />
        <Scene flow={flow} onLand={() => setCount((c) => c + 1)} />
      </Canvas>

      {/* Overlay controls */}
      <div className="pointer-events-none absolute inset-x-5 bottom-4 flex items-end justify-between gap-3 sm:inset-x-8 lg:right-28 lg:bottom-28">
        <div className="rounded-xl border border-line bg-ink/70 px-3.5 py-2.5 backdrop-blur-md">
          <p className="font-mono text-[10px] tracking-[0.14em] text-subtle uppercase">PDF exportados</p>
          <div className="relative h-6 overflow-hidden font-mono text-lg leading-6 text-white tabular-nums">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={count}
                initial={{ y: 18, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: -18, opacity: 0 }}
                transition={{ duration: 0.25 }}
                className="block"
              >
                {count.toString().padStart(3, '0')}
              </motion.span>
            </AnimatePresence>
          </div>
        </div>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            boost();
          }}
          className={`pointer-events-auto inline-flex cursor-pointer items-center gap-2 rounded-full border px-4 py-2.5 text-sm font-medium backdrop-blur-md transition-all ${
            boosting
              ? 'border-accent bg-accent text-ink shadow-[0_0_30px_-4px_rgba(34,211,238,0.7)]'
              : 'border-accent/40 bg-ink/70 text-white hover:border-accent'
          }`}
        >
          <Zap className={`h-4 w-4 ${boosting ? 'animate-pulse' : 'text-accent'}`} />
          {boosting ? 'Exportando…' : 'Exportar set'}
        </button>
      </div>
    </div>
  );
}

export default BimCanvas;
