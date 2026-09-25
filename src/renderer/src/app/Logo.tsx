/** The podium mark from the app icon, drawn inline so it follows the theme colours. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <rect x="6" y="30" width="16" height="26" rx="3" className="fill-accent" opacity="0.8" />
      <rect x="24" y="20" width="16" height="36" rx="3" className="fill-accent" />
      <rect x="42" y="36" width="16" height="20" rx="3" className="fill-accent" opacity="0.65" />
      <circle cx="32" cy="9" r="6" className="fill-rec" />
    </svg>
  )
}
