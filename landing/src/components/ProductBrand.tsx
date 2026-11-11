export function ProductBrand({ light = false }: { light?: boolean }) {
  return <span className={`inline-flex items-center gap-2.5 ${light ? 'text-white' : 'text-navy'}`}>
    <img src="/brand/isotipo.png" alt="" width={40} height={40} className="h-9 w-9 object-contain sm:h-10 sm:w-10" />
    <span className="flex flex-col gap-1"><span className="text-[28px] leading-none font-extrabold tracking-[-0.055em] sm:text-[32px]">Xport</span><span className={`text-[9px] leading-none font-medium tracking-[0.06em] ${light ? 'text-slate-300' : 'text-slate-500'}`}>por BimFlow</span></span>
  </span>;
}
