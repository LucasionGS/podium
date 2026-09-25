import { useEffect, useState } from 'react'
import { AlertTriangle, Copy, X } from 'lucide-react'
import type { Hotkey } from '@shared/ipc'
import { acceleratorFromKey } from '@core/hotkeys'
import { Select } from '@/ui/Field'
import { formatLength } from '@/lib/format'
import { updateSettings, useApp } from '@/store/app'
import { Group, Row } from './Row'

const CLIP_LENGTHS = [10, 15, 30, 45, 60, 90, 120, 180, 300]

function Recorder({
  value,
  onChange
}: {
  value: string | null
  onChange: (accelerator: string | null) => void
}) {
  const [recording, setRecording] = useState(false)
  useEffect(() => {
    if (!recording) return
    // Global hotkeys would fire (and swallow the keys) while the user presses them here.
    window.podium.hotkeys.suspend(true)
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') return setRecording(false)
      const accelerator = acceleratorFromKey(e)
      if (!accelerator) return
      onChange(accelerator)
      setRecording(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.podium.hotkeys.suspend(false)
    }
  }, [recording, onChange])
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        className={`h-7 min-w-32 rounded-md border px-2.5 font-mono text-xs ${
          recording ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-raised hover:border-faint'
        }`}
      >
        {recording ? 'Press keys…' : (value ?? 'Not set')}
      </button>
      {value && (
        <button
          type="button"
          className="p-1 text-faint hover:text-fg"
          aria-label="Clear hotkey"
          onClick={() => onChange(null)}
        >
          <X size={13} />
        </button>
      )}
    </div>
  )
}

function CopyLine({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-line bg-bg px-3 py-1.5">
      <code className="min-w-0 flex-1 truncate font-mono text-2xs select-text" title={text}>
        {text}
      </code>
      <button
        className="text-faint hover:text-fg"
        aria-label="Copy"
        onClick={() => window.podium.app.copyText(text)}
      >
        <Copy size={12} />
      </button>
    </div>
  )
}

export function HotkeySettings() {
  const hotkeys = useApp((s) => s.settings!.hotkeys)
  const status = useApp((s) => s.hotkeys)
  const failure = (id: string): string | undefined => status?.failed.find((f) => f.id === id)?.reason
  const set = (id: string, patch: Partial<Hotkey>): void =>
    void updateSettings({ hotkeys: hotkeys.map((h) => (h.id === id ? { ...h, ...patch } : h)) })

  return (
    <>
      <Group title="Hotkeys">
        {hotkeys.map((hotkey) => (
          <Row
            key={hotkey.id}
            label={hotkey.action.kind === 'clip' ? 'Save a clip' : 'Bookmark (save the whole buffer)'}
            hint={
              failure(hotkey.id) ? (
                <span className="flex items-center gap-1 text-warn">
                  <AlertTriangle size={12} /> {failure(hotkey.id)}
                </span>
              ) : hotkey.action.kind === 'bookmark' ? (
                'Keeps everything in the buffer, marked for review, so you can trim it later.'
              ) : undefined
            }
          >
            {hotkey.action.kind === 'clip' && (
              <Select
                value={hotkey.action.seconds}
                onChange={(e) =>
                  set(hotkey.id, { action: { kind: 'clip', seconds: Number(e.target.value) } })
                }
                className="w-32 flex-none"
                aria-label="Clip length"
              >
                {CLIP_LENGTHS.map((s) => (
                  <option key={s} value={s}>
                    Last {formatLength(s)}
                  </option>
                ))}
              </Select>
            )}
            <Recorder
              value={hotkey.accelerator}
              onChange={(accelerator) => set(hotkey.id, { accelerator })}
            />
          </Row>
        ))}
      </Group>

      {status && (
        <p className="-mt-4 mb-7 text-xs leading-relaxed text-muted">
          {status.mechanism === 'hyprland'
            ? 'While Podium runs, it adds these keys to Hyprland itself, so they work in fullscreen games. Nothing to add to your config.'
            : status.mechanism === 'portal'
              ? 'Registered through your desktop’s shortcut settings; your desktop may ask you to confirm them once.'
              : 'These keys work everywhere, including in fullscreen games.'}
        </p>
      )}

      <Group title="Command line">
        <div className="py-3.5">
          <p className="mb-3 text-xs leading-relaxed text-muted">
            Bind this in any desktop environment, stream deck or script to save a clip from the running
            Podium. Use <code className="text-fg">--clip=60</code> for another length, or{' '}
            <code className="text-fg">--bookmark</code>.
          </p>
          {status && <CopyLine text={status.cliCommand} />}
        </div>
      </Group>
    </>
  )
}
