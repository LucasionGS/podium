import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { create } from 'zustand'

export type MenuItem =
  | {
      type?: 'item'
      label: string
      icon?: ReactNode
      shortcut?: string
      disabled?: boolean
      danger?: boolean
      checked?: boolean
      onSelect(): void
    }
  | { type: 'submenu'; label: string; icon?: ReactNode; disabled?: boolean; items: MenuItem[] }
  | { type: 'separator' }

interface MenuState {
  menu: { x: number; y: number; items: MenuItem[] } | null
}

const useMenu = create<MenuState>(() => ({ menu: null }))

/** Opens a context menu at the pointer. Call from an `onContextMenu` handler. */
export function openContextMenu(
  event: { clientX: number; clientY: number; preventDefault(): void },
  items: MenuItem[]
): void {
  event.preventDefault()
  // Separators at the edges or doubled up come from conditionally built menus; tidy them away.
  const tidy = items.filter(
    (item, i, all) =>
      item.type !== 'separator' || (i > 0 && i < all.length - 1 && all[i - 1]!.type !== 'separator')
  )
  useMenu.setState({ menu: tidy.length ? { x: event.clientX, y: event.clientY, items: tidy } : null })
}

export const closeContextMenu = (): void => useMenu.setState({ menu: null })

/** Mount once at the app root. */
export function ContextMenuHost() {
  const menu = useMenu((s) => s.menu)
  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeContextMenu()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', closeContextMenu)
    window.addEventListener('resize', closeContextMenu)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', closeContextMenu)
      window.removeEventListener('resize', closeContextMenu)
    }
  }, [menu])
  if (!menu) return null
  return (
    <div
      className="fixed inset-0 z-[60]"
      onPointerDown={(e) => e.target === e.currentTarget && closeContextMenu()}
      onContextMenu={(e) => {
        e.preventDefault()
        if (e.target === e.currentTarget) closeContextMenu()
      }}
      onWheel={closeContextMenu}
    >
      <MenuList items={menu.items} x={menu.x} y={menu.y} />
    </div>
  )
}

function MenuList({
  items,
  x,
  y,
  parentWidth = 0
}: {
  items: MenuItem[]
  x: number
  y: number
  parentWidth?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [open, setOpen] = useState<number | null>(null)

  // Keep the menu on screen: flip to the other side of the pointer/parent when it would overflow.
  useLayoutEffect(() => {
    const el = ref.current!
    const margin = 6
    let left = x
    let top = y
    if (left + el.offsetWidth > window.innerWidth - margin)
      left = Math.max(margin, x - el.offsetWidth - parentWidth)
    if (top + el.offsetHeight > window.innerHeight - margin)
      top = Math.max(margin, window.innerHeight - margin - el.offsetHeight)
    setPosition({ left, top })
  }, [x, y, parentWidth])

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed min-w-48 rounded-lg border border-line bg-raised py-1 shadow-2xl shadow-black/60"
      style={{
        left: position?.left ?? x,
        top: position?.top ?? y,
        visibility: position ? 'visible' : 'hidden'
      }}
    >
      {items.map((item, i) => {
        if (item.type === 'separator') return <div key={i} role="separator" className="my-1 h-px bg-line" />
        const base = `flex h-7 w-full items-center gap-2 px-2.5 text-left text-xs ${
          item.disabled
            ? 'text-faint'
            : 'danger' in item && item.danger
              ? 'text-danger hover:bg-danger/15'
              : 'text-fg hover:bg-accent-soft'
        }`
        if (item.type === 'submenu') {
          return (
            <SubmenuRow
              key={i}
              item={item}
              className={`${base} ${open === i ? 'bg-accent-soft' : ''}`}
              isOpen={open === i}
              onOpen={() => setOpen(item.disabled ? null : i)}
            />
          )
        }
        return (
          <button
            key={i}
            role="menuitem"
            disabled={item.disabled}
            className={base}
            onPointerEnter={() => setOpen(null)}
            onClick={() => {
              closeContextMenu()
              item.onSelect()
            }}
          >
            <span className="flex w-4 shrink-0 justify-center text-muted">
              {item.checked ? '✓' : item.icon}
            </span>
            <span className="flex-1 truncate">{item.label}</span>
            {item.shortcut && <span className="pl-4 font-mono text-2xs text-faint">{item.shortcut}</span>}
          </button>
        )
      })}
    </div>
  )
}

function SubmenuRow({
  item,
  className,
  isOpen,
  onOpen
}: {
  item: Extract<MenuItem, { type: 'submenu' }>
  className: string
  isOpen: boolean
  onOpen(): void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const rect = isOpen ? ref.current?.getBoundingClientRect() : undefined
  return (
    <>
      <button
        ref={ref}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        disabled={item.disabled}
        className={className}
        onPointerEnter={onOpen}
        onClick={onOpen}
      >
        <span className="flex w-4 shrink-0 justify-center text-muted">{item.icon}</span>
        <span className="flex-1 truncate">{item.label}</span>
        <ChevronRight size={12} className="text-faint" />
      </button>
      {rect && (
        <MenuList items={item.items} x={rect.right - 2} y={rect.top - 5} parentWidth={rect.width - 4} />
      )}
    </>
  )
}
