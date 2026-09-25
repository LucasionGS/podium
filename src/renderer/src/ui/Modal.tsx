import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { IconButton } from './IconButton'

export function Modal({
  title,
  onClose,
  children,
  width = 520
}: {
  title: string
  onClose: () => void
  children: ReactNode
  width?: number
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
      // The editor's shortcuts must not fire behind a dialog.
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal
      aria-label={title}
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="flex max-h-full flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl shadow-black/60"
        style={{ width }}
      >
        <header className="flex h-11 shrink-0 items-center justify-between border-b border-line pr-2 pl-4">
          <h2 className="text-sm font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <X size={15} />
          </IconButton>
        </header>
        <div className="min-h-0 overflow-auto">{children}</div>
      </div>
    </div>
  )
}
