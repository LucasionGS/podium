import type { ButtonHTMLAttributes } from 'react'

export function IconButton({
  label,
  active = false,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      className={`inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-35 ${
        active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-hover hover:text-fg'
      } ${className}`}
      {...props}
    />
  )
}
