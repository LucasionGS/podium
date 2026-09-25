import type { Monitor, MonitorBounds } from '@shared/ipc'

/** The fields of `hyprctl monitors -j` we use. */
export interface HyprMonitor {
  name: string
  make?: string
  model?: string
  x: number
  y: number
  width: number
  height: number
  scale?: number
  /** wl_output transform: odd values are rotated 90° or 270°. */
  transform?: number
  focused?: boolean
}

/** EDID makes that carry no information. */
const PLACEHOLDER_MAKES = /^(xxx|unknown|default|generic)?$/i

/** `ASUSTek COMPUTER INC` + `XG258` → `ASUSTek XG258`; `Acer Technologies` + `Acer B246HYL` → `Acer B246HYL`. */
export function monitorName(make = '', model = ''): string | undefined {
  const brand = make.trim().split(/\s+/)[0] ?? ''
  model = model.trim()
  if (!model) return PLACEHOLDER_MAKES.test(brand) ? undefined : make.trim()
  if (PLACEHOLDER_MAKES.test(brand) || model.toLowerCase().startsWith(brand.toLowerCase())) return model
  return `${brand} ${model}`
}

/** Adds where each monitor sits on the desktop and its model name, from Hyprland's view of the outputs. */
export function withHyprlandLayout(monitors: Monitor[], hypr: HyprMonitor[]): Monitor[] {
  return monitors.map((m) => {
    const h = hypr.find((o) => o.name === m.id)
    if (!h) return m
    const scale = h.scale || 1
    const rotated = (h.transform ?? 0) % 2 === 1
    const bounds: MonitorBounds = {
      x: h.x,
      y: h.y,
      width: Math.round((rotated ? h.height : h.width) / scale),
      height: Math.round((rotated ? h.width : h.height) / scale)
    }
    return { ...m, bounds, label: m.label ?? monitorName(h.make, h.model) }
  })
}

export interface DeskTile {
  id: string
  /** Fractions of the desk's width and height. */
  left: number
  top: number
  width: number
  height: number
}

/**
 * Where to draw each monitor in a picker, scaled into a unit box of the given aspect ratio (width / height).
 * Uses the real arrangement when every monitor has bounds; otherwise lines them up side by side.
 */
export function deskLayout(monitors: Monitor[]): { aspect: number; tiles: DeskTile[] } {
  if (!monitors.length) return { aspect: 16 / 9, tiles: [] }
  let x = 0
  const rects = monitors.every((m) => m.bounds)
    ? monitors.map((m) => ({ id: m.id, ...m.bounds! }))
    : monitors.map((m) => {
        const rect = { id: m.id, x, y: 0, width: m.width, height: m.height }
        x += m.width
        return rect
      })
  const left = Math.min(...rects.map((r) => r.x))
  const top = Math.min(...rects.map((r) => r.y))
  const width = Math.max(...rects.map((r) => r.x + r.width)) - left
  const height = Math.max(...rects.map((r) => r.y + r.height)) - top
  return {
    aspect: width / height,
    tiles: rects.map((r) => ({
      id: r.id,
      left: (r.x - left) / width,
      top: (r.y - top) / height,
      width: r.width / width,
      height: r.height / height
    }))
  }
}
