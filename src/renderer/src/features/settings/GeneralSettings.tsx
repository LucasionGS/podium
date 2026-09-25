import { Volume2 } from 'lucide-react'
import type { AppSettings } from '@shared/ipc'
import { Button } from '@/ui/Button'
import { Switch } from '@/ui/Switch'
import { playCue } from '@/lib/cue'
import { updateSettings, useApp } from '@/store/app'
import { Group, Row } from './Row'

export function GeneralSettings() {
  const settings = useApp((s) => s.settings!)
  const info = useApp((s) => s.info)
  const { notifications, startup } = settings
  const notify = (patch: Partial<AppSettings['notifications']>): void =>
    void updateSettings({ notifications: { ...notifications, ...patch } })
  const start = (patch: Partial<AppSettings['startup']>): void =>
    void updateSettings({ startup: { ...startup, ...patch } })

  return (
    <>
      <Group title="When a clip is saved">
        <Row label="Play a sound" hint="Works over fullscreen games.">
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={notifications.soundVolume}
            disabled={!notifications.sound}
            onChange={(e) => notify({ soundVolume: Number(e.target.value) })}
            aria-label="Sound volume"
            className="w-28"
          />
          <Button variant="ghost" onClick={() => playCue(notifications.soundVolume)} aria-label="Test sound">
            <Volume2 size={13} />
          </Button>
          <Switch
            label="Play a sound"
            checked={notifications.sound}
            onChange={(sound) => notify({ sound })}
          />
        </Row>
        <Row label="Show a notification" hint="With a thumbnail; click it to open the clip.">
          <Switch
            label="Show a notification"
            checked={notifications.system}
            onChange={(system) => notify({ system })}
          />
        </Row>
      </Group>

      <Group title="Startup">
        <Row label="Start Podium when you log in">
          <Switch
            label="Start Podium when you log in"
            checked={startup.autostart}
            onChange={(autostart) => start({ autostart })}
          />
        </Row>
        <Row label="Start in the tray" hint="Only the tray icon appears; the buffer runs in the background.">
          <Switch
            label="Start in the tray"
            checked={startup.startHidden}
            onChange={(startHidden) => start({ startHidden })}
          />
        </Row>
        <Row
          label="Keep running when the window is closed"
          hint="The replay buffer keeps going; quit from the tray icon."
        >
          <Switch
            label="Keep running when the window is closed"
            checked={settings.closeToTray}
            onChange={(closeToTray) => void updateSettings({ closeToTray })}
          />
        </Row>
      </Group>

      <Group title="About">
        <Row
          label={`Podium ${info?.version ?? ''}`}
          hint={`Open source, local-first game clipping · ${info?.platform ?? ''}${info?.desktop ? ` · ${info.desktop}` : ''}${info?.sessionType ? ` (${info.sessionType})` : ''}`}
        >
          <span />
        </Row>
      </Group>
    </>
  )
}
