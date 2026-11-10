/**
 * Decoración de marca tomada del manual: formas diagonales de esquinas redondeadas con degradado azul → turquesa
 * y líneas finas con el mismo degradado. Solo ornamento (aria-hidden).
 */
export function BrandArt({ className = '' }: { className?: string }) {
  return (
    <svg
      className={`pointer-events-none absolute inset-0 h-full w-full ${className}`}
      viewBox="0 0 1440 820"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="art-fill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#005bae" stopOpacity="0.20" />
          <stop offset="1" stopColor="#00afb7" stopOpacity="0.16" />
        </linearGradient>
        <linearGradient id="art-line" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#00afb7" />
          <stop offset="1" stopColor="#005bae" />
        </linearGradient>
        <radialGradient id="art-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#00afb7" stopOpacity="0.20" />
          <stop offset="1" stopColor="#00afb7" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="1180" cy="170" r="330" fill="url(#art-glow)" />
      <circle cx="140" cy="720" r="300" fill="url(#art-glow)" />
      {/* Arriba a la derecha */}
      <rect x="1050" y="-190" width="360" height="360" rx="64" transform="rotate(45 1230 -10)" fill="url(#art-fill)" />
      <path
        d="M760 -20 L1100 320 Q1125 345 1160 345 L1215 345 Q1250 345 1275 370 L1440 535"
        fill="none"
        stroke="url(#art-line)"
        strokeWidth="1.5"
      />
      {/* Abajo a la izquierda */}
      <rect x="-210" y="640" width="320" height="320" rx="60" transform="rotate(45 -50 800)" fill="url(#art-fill)" />
      <path
        d="M-20 560 L210 790 Q235 815 270 815 L330 815 Q365 815 390 840"
        fill="none"
        stroke="url(#art-line)"
        strokeWidth="1.5"
      />
    </svg>
  );
}
