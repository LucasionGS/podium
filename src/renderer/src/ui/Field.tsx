import type { ReactNode, SelectHTMLAttributes } from 'react'

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex min-h-7 items-center gap-3">
      <span className="w-24 shrink-0 text-xs text-muted">{label}</span>
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
      {hint && <span className="text-2xs text-faint">{hint}</span>}
    </label>
  )
}

export function Select({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`h-7 min-w-0 flex-1 rounded-md border border-line bg-raised px-2 text-xs text-fg outline-none hover:border-faint focus-visible:border-accent ${className}`}
      {...props}
    />
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (value: T) => void
}) {
  return (
    <div className="flex flex-1 rounded-md border border-line bg-bg p-0.5" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={`h-6 flex-1 rounded text-xs transition-colors ${o.value === value ? 'bg-raised text-fg shadow-sm' : 'text-muted hover:text-fg'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
