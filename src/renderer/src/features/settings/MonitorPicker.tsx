import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { Monitor } from '@shared/ipc'
import { deskLayout } from '@core/capture/monitors'
import { IconButton } from '@/ui/IconButton'
import { useApp } from '@/store/app'

/** Tallest the desk drawing gets; wide setups use the full width instead. */
const DESK_HEIGHT = 200

const describe = (m: Monitor): string => [m.label, m.id, `${m.width}×${m.height}`].filter(Boolean).join(' · ')

/**
 * Picks the monitor to record: the monitors drawn where they sit on the desk, each with a snapshot of
 * what it shows, so the right one is obvious without knowing connector names.
 */
export function MonitorPicker({
  value,
  onChange
}: {
  value: string | null
  onChange: (monitor: string | null) => void
}) {
  const monitors = useApp((s) => s.capabilities?.monitors) ?? []
  const status = useApp((s) => s.status)
  const [previews, setPreviews] = useState<Record<string, string | null>>({})
  const [hovered, setHovered] = useState<string | null>(null)
  const ids = monitors.map((m) => m.id).join('|')

  const refresh = useCallback(() => {
    for (const id of ids.split('|').filter(Boolean)) {
      void window.podium.capture
        .preview(id)
        .catch(() => null)
        .then((url) => setPreviews((p) => ({ ...p, [id]: url ?? p[id] ?? null })))
    }
  }, [ids])

  // Snapshots go stale while Podium is in the background, so take fresh ones when it comes back.
  useEffect(() => {
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])

  const { aspect, tiles } = deskLayout(monitors)
  const recording =
    status && (status.state === 'buffering' || status.state === 'starting') ? status.monitor?.id : null
  const shown = monitors.find((m) => m.id === (hovered ?? value))
  const hint = shown
    ? describe(shown)
    : recording
      ? `Records the monitor that has focus when the buffer starts (now ${recording}).`
      : 'Records the monitor that has focus when the buffer starts.'

  return (
    <div className="border-b border-line py-3.5 last:border-b-0">
      <div className="flex items-center gap-6">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">Monitor</div>
          <div className="mt-0.5 truncate text-xs leading-relaxed text-muted">{hint}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            aria-pressed={value === null}
            onClick={() => onChange(null)}
            className={`h-7 rounded-md border px-2.5 text-xs font-medium transition-colors ${
              value === null
                ? 'border-accent/40 bg-accent-soft text-accent'
                : 'border-line text-muted hover:bg-hover hover:text-fg'
            }`}
          >
            Automatic
          </button>
          <IconButton label="Refresh previews" onClick={refresh}>
            <RefreshCw size={13} />
          </IconButton>
        </div>
      </div>

      {monitors.length > 0 && (
        <div className="mt-3 flex justify-center rounded-lg bg-bg p-3">
          <div
            role="radiogroup"
            aria-label="Monitor"
            className="relative"
            style={{ width: `min(100%, ${Math.round(DESK_HEIGHT * aspect)}px)`, aspectRatio: aspect }}
          >
            {tiles.map((tile) => {
              const monitor = monitors.find((m) => m.id === tile.id)!
              const selected = value === tile.id
              const preview = previews[tile.id]
              return (
                <button
                  key={tile.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={describe(monitor)}
                  title={describe(monitor)}
                  onClick={() => onChange(tile.id)}
                  onMouseEnter={() => setHovered(tile.id)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(tile.id)}
                  onBlur={() => setHovered(null)}
                  className="group absolute p-[3px] outline-none"
                  style={{
                    left: `${tile.left * 100}%`,
                    top: `${tile.top * 100}%`,
                    width: `${tile.width * 100}%`,
                    height: `${tile.height * 100}%`
                  }}
                >
                  <span
                    className={`relative flex size-full items-center justify-center overflow-hidden rounded-md border bg-raised transition-[border-color,box-shadow] ${
                      selected
                        ? 'border-accent shadow-[0_0_0_1px_var(--color-accent)]'
                        : 'border-line group-hover:border-faint group-focus-visible:border-accent'
                    }`}
                  >
                    {preview ? (
                      <img
                        src={preview}
                        alt=""
                        draggable={false}
                        className={`absolute inset-0 size-full object-cover transition-opacity ${
                          selected ? '' : 'opacity-60 group-hover:opacity-90'
                        }`}
                      />
                    ) : (
                      <span className="text-2xs text-faint">
                        {preview === undefined ? '' : `${monitor.width}×${monitor.height}`}
                      </span>
                    )}
                    <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/75 to-transparent px-1.5 pt-3 pb-1 text-left text-2xs font-medium text-white">
                      {monitor.id}
                    </span>
                    {recording === tile.id && (
                      <span
                        className="absolute top-1.5 right-1.5 size-2 rounded-full bg-rec shadow-[0_0_0_2px_rgb(0_0_0/0.4)]"
                        title="Recording this monitor"
                      />
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
