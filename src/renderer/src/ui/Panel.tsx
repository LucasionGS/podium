import type { ReactNode } from 'react'

export function PanelFrame({
  title,
  actions,
  children
}: {
  title: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col bg-surface">
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
        <h2 className="text-2xs font-semibold tracking-wider text-muted uppercase">{title}</h2>
        {actions}
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  )
}

export function EmptyState({ icon, title, hint }: { icon: ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <div className="text-faint">{icon}</div>
      <p className="text-xs font-medium text-muted">{title}</p>
      {hint && <p className="max-w-56 text-2xs leading-relaxed text-faint">{hint}</p>}
    </div>
  )
}
