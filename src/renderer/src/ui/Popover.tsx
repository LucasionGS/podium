import { useEffect, useRef, useState, type ReactNode } from 'react'

/** A small panel anchored under its trigger. Closes on outside click or Esc. */
export function Popover({
  trigger,
  children,
  label
}: {
  trigger: (toggle: () => void, open: boolean) => ReactNode
  children: ReactNode
  label: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <span ref={ref} className="relative inline-flex">
      {trigger(() => setOpen((v) => !v), open)}
      {open && (
        <div
          role="dialog"
          aria-label={label}
          className="absolute top-full left-0 z-50 mt-1.5 w-72 rounded-lg border border-line bg-raised p-3 shadow-2xl shadow-black/60"
        >
          {children}
        </div>
      )}
    </span>
  )
}
