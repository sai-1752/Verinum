export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="7" fill="rgb(var(--thread))" />
      <path d="M7 21c4 0 5-10 9-10s5 10 9 10" fill="none" stroke="rgb(var(--panel))" strokeWidth="2.6" strokeLinecap="round" />
      <rect x="7" y="24" width="18" height="3" rx="1.5" fill="rgb(var(--marker))" />
    </svg>
  );
}
export function Logo({ className = "" }: { className?: string }) {
  return <span className={`inline-flex items-center gap-2 ${className}`}><LogoMark /><span className="font-serif text-[1.25rem] font-medium tracking-tight text-ink">Verinum</span></span>;
}
