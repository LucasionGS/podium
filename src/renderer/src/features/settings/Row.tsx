import type { ReactNode } from 'react'

/** A settings row: label and explanation on the left, the control on the right. */
export function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-6 border-b border-line py-3.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-xs leading-relaxed text-muted">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

export function Group({
  title,
  children,
  action
}: {
  title: string
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <section className="mb-7">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-2xs font-semibold tracking-wider text-faint uppercase">{title}</h2>
        {action}
      </div>
      <div className="rounded-xl border border-line bg-surface px-4">{children}</div>
    </section>
  )
}
