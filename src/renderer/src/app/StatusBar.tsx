import { useEffect, useState } from 'react'
import { Gamepad2, Power, Scissors } from 'lucide-react'
import type { CaptureStatus } from '@shared/ipc'
import { Button } from '@/ui/Button'
import { codecLabel, formatDuration, formatLength } from '@/lib/format'
import { navigate, saveClip, useApp } from '@/store/app'

const LABELS: Record<CaptureStatus['state'], string> = {
  off: 'Replay buffer off',
  starting: 'Starting…',
  buffering: 'Replay buffer on',
  paused: 'Paused',
  error: 'Replay buffer stopped',
  unavailable: 'Recording unavailable'
}

/** Seconds currently held in the buffer; ticks every second while buffering. */
function useBuffered(status: CaptureStatus | null): number {
  const [now, setNow] = useState(Date.now())
  const buffering = status?.state === 'buffering'
  useEffect(() => {
    if (!buffering) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [buffering])
  if (!status?.since || !buffering) return 0
  return Math.min(status.bufferSeconds, Math.max(0, (now - status.since) / 1000))
}

export function StatusBar() {
  const status = useApp((s) => s.status)
  const game = useApp((s) => s.game)
  const shortHotkey = useApp((s) => s.settings?.hotkeys.find((h) => h.action.kind === 'clip'))
  const buffered = useBuffered(status)
  if (!status) return null
  const state = status.state
  const on = state === 'buffering' || state === 'starting'
  const dot =
    state === 'buffering'
      ? 'bg-rec animate-rec'
      : state === 'starting'
        ? 'bg-warn'
        : state === 'error'
          ? 'bg-danger'
          : 'bg-faint'

  return (
    <footer className="flex h-11 shrink-0 items-center gap-4 border-t border-line bg-surface px-4 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <span className={`size-2 shrink-0 rounded-full ${dot}`} aria-hidden />
        <span className="font-medium">{LABELS[state]}</span>
        {state === 'buffering' && (
          <span className="text-muted tabular-nums">
            {formatDuration(buffered)} / {formatDuration(status.bufferSeconds)}
          </span>
        )}
        {status.message && state !== 'buffering' && (
          <button
            className="min-w-0 truncate text-left text-danger hover:underline"
            title={status.message}
            onClick={() => navigate({ view: 'settings', tab: 'recording' })}
          >
            {status.message}
          </button>
        )}
      </div>

      {status.monitor && on && (
        <span className="hidden truncate text-faint lg:inline">
          {status.monitor.label ?? status.monitor.id} · {status.monitor.width}×{status.monitor.height} ·{' '}
          {status.fps} fps · {codecLabel(status.codec)}
        </span>
      )}

      <div className="ml-auto flex items-center gap-3">
        {game && (
          <span
            className="flex max-w-56 items-center gap-1.5 text-muted"
            title="Clips are tagged with this game"
          >
            <Gamepad2 size={14} className="shrink-0 text-ok" />
            <span className="truncate">{game.name}</span>
          </span>
        )}
        {state !== 'unavailable' && (
          <Button
            variant="ghost"
            onClick={() => void (on ? window.podium.capture.stop() : window.podium.capture.start())}
            title={on ? 'Stop the replay buffer' : 'Start the replay buffer'}
          >
            <Power size={13} />
            {on ? 'Stop' : 'Start'}
          </Button>
        )}
        <Button
          variant="primary"
          disabled={state !== 'buffering'}
          onClick={() => void saveClip(shortHotkey?.action ?? { kind: 'clip', seconds: 30 })}
        >
          <Scissors size={13} />
          Clip {formatLength(shortHotkey?.action.kind === 'clip' ? shortHotkey.action.seconds : 30)}
          {shortHotkey?.accelerator && (
            <kbd className="ml-1 rounded bg-white/15 px-1 font-sans text-2xs">{shortHotkey.accelerator}</kbd>
          )}
        </Button>
      </div>
    </footer>
  )
}
