import { useEffect, useRef, useState } from 'react'
import type { Filmstrip } from '@shared/ipc'
import { startDrag } from '@/lib/drag'
import { formatPrecise } from '@/lib/format'

const MIN_LENGTH = 0.5
const HEIGHT = 64

/** Filmstrip with in/out handles and a playhead. Dragging the strip scrubs; dragging a handle trims. */
export function TrimBar({
  duration,
  start,
  end,
  time,
  filmstrip,
  onTrim,
  onSeek
}: {
  duration: number
  start: number
  end: number
  time: number
  filmstrip: Filmstrip | null
  onTrim: (start: number, end: number) => void
  onSeek: (time: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const x = (t: number): number => (duration > 0 ? (t / duration) * width : 0)
  const timeAt = (clientX: number): number => {
    const rect = ref.current!.getBoundingClientRect()
    return Math.max(0, Math.min(duration, ((clientX - rect.left) / rect.width) * duration))
  }

  // Tiles keep their aspect ratio: pick as many as fit and sample the sprite evenly.
  const tiles = (() => {
    if (!filmstrip || !width) return []
    const tileWidth = (filmstrip.tileWidth * HEIGHT) / filmstrip.tileHeight
    const count = Math.max(1, Math.ceil(width / tileWidth))
    return Array.from({ length: count }, (_, i) => ({
      left: i * tileWidth,
      width: tileWidth,
      index: Math.min(filmstrip.count - 1, Math.floor((i / count) * filmstrip.count))
    }))
  })()

  const dragHandle = (which: 'start' | 'end') => (e: React.PointerEvent) => {
    e.stopPropagation()
    const initial = which === 'start' ? start : end
    const perPixel = duration / (ref.current?.clientWidth || 1)
    startDrag(e, {
      threshold: 0,
      onMove: (dx) => {
        const t = initial + dx * perPixel
        if (which === 'start') {
          const next = Math.max(0, Math.min(t, end - MIN_LENGTH))
          onTrim(next, end)
          onSeek(next)
        } else {
          const next = Math.min(duration, Math.max(t, start + MIN_LENGTH))
          onTrim(start, next)
          onSeek(next)
        }
      }
    })
  }

  return (
    <div className="select-none">
      <div
        ref={ref}
        className="relative cursor-pointer overflow-hidden rounded-md bg-raised"
        style={{ height: HEIGHT }}
        onPointerDown={(e) => {
          onSeek(timeAt(e.clientX))
          startDrag(e, { threshold: 0, onMove: (_dx, _dy, ev) => onSeek(timeAt(ev.clientX)) })
        }}
      >
        {filmstrip &&
          tiles.map((tile, i) => (
            <div
              key={i}
              className="absolute top-0 h-full"
              style={{
                left: tile.left,
                width: tile.width,
                backgroundImage: `url("${filmstrip.url}")`,
                backgroundSize: `${filmstrip.count * tile.width}px ${HEIGHT}px`,
                backgroundPosition: `${-tile.index * tile.width}px 0`
              }}
            />
          ))}
        {/* Everything outside the selection is dimmed. */}
        <div className="absolute inset-y-0 left-0 bg-black/65" style={{ width: x(start) }} />
        <div
          className="absolute inset-y-0 right-0 bg-black/65"
          style={{ width: Math.max(0, width - x(end)) }}
        />
        <div
          className="pointer-events-none absolute inset-y-0 rounded-md border-2 border-accent"
          style={{ left: x(start), width: Math.max(0, x(end) - x(start)) }}
        />
        <Handle left={x(start)} side="start" onPointerDown={dragHandle('start')} />
        <Handle left={x(end)} side="end" onPointerDown={dragHandle('end')} />
        <div
          className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_4px_rgba(0,0,0,0.8)]"
          style={{ left: x(time) }}
        />
      </div>
      <div className="mt-1 flex justify-between text-2xs text-muted tabular-nums">
        <span>{formatPrecise(start)}</span>
        <span>{formatPrecise(end)}</span>
      </div>
    </div>
  )
}

function Handle({
  left,
  side,
  onPointerDown
}: {
  left: number
  side: 'start' | 'end'
  onPointerDown: (e: React.PointerEvent) => void
}) {
  return (
    <div
      role="slider"
      aria-label={side === 'start' ? 'Trim start' : 'Trim end'}
      onPointerDown={onPointerDown}
      className={`absolute inset-y-0 z-10 flex w-3 cursor-ew-resize items-center justify-center bg-accent ${
        side === 'start' ? 'rounded-l-md' : '-translate-x-full rounded-r-md'
      }`}
      style={{ left }}
    >
      <span className="h-5 w-0.5 rounded bg-white/80" />
    </div>
  )
}
