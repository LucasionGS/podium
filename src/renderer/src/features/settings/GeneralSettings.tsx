import { ExternalLink, Volume2 } from 'lucide-react'
import type { AppSettings } from '@shared/ipc'
import { Button } from '@/ui/Button'
import { Switch } from '@/ui/Switch'
import { playCue } from '@/lib/cue'
import { updateSettings, useApp } from '@/store/app'
import { checkForUpdates, installUpdate, useUpdates } from '@/store/updates'
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

      <Group title="Updates">
        <UpdateRow />
        <Row
          label="Check for updates automatically"
          hint="When Podium starts and every few hours, on GitHub."
        >
          <Switch
            label="Check for updates automatically"
            checked={settings.updates.check}
            onChange={(check) => void updateSettings({ updates: { check } })}
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

function UpdateRow() {
  const status = useUpdates((s) => s.status)
  if (!status) return null
  const { state, available } = status
  const working = state === 'downloading' || state === 'installing'
  const checked = status.checkedAt ? new Date(status.checkedAt).toLocaleString() : null

  const label = available
    ? state === 'ready'
      ? `Podium ${available.version} is installed`
      : `Podium ${available.version} is available`
    : state === 'up-to-date'
      ? 'Podium is up to date'
      : `Podium ${status.current}`
  const hint = (
    <>
      {working && (
        <span className="mt-1.5 block h-1 overflow-hidden rounded bg-line">
          <span
            className={`block h-full bg-accent transition-[width] ${status.progress === null ? 'animate-pulse' : ''}`}
            style={{ width: `${(status.progress ?? 1) * 100}%` }}
          />
        </span>
      )}
      {status.message && (
        <span className={`mt-1 block break-words select-text ${state === 'error' ? 'text-danger' : ''}`}>
          {status.message}
        </span>
      )}
      {!working && !status.message && (
        <span className="block">
          {state === 'ready'
            ? 'Restart Podium to start using it.'
            : available
              ? `You have ${status.current}. ${status.method}`
              : `${status.method}${checked ? ` Last checked ${checked}.` : ''}`}
        </span>
      )}
    </>
  )

  return (
    <Row label={label} hint={hint}>
      {available && (
        <Button variant="ghost" onClick={() => window.podium.app.openExternal(available.url)}>
          <ExternalLink size={13} /> What’s new
        </Button>
      )}
      {state === 'ready' ? (
        <Button variant="primary" onClick={() => window.podium.updates.restart()}>
          Restart now
        </Button>
      ) : available && status.canInstall ? (
        <Button variant="primary" disabled={working} onClick={() => void installUpdate()}>
          {working ? 'Updating…' : state === 'error' ? 'Try again' : 'Install update'}
        </Button>
      ) : available ? (
        <Button onClick={() => window.podium.app.openExternal(available.url)}>Download</Button>
      ) : (
        <Button disabled={state === 'checking'} onClick={() => void checkForUpdates()}>
          {state === 'checking' ? 'Checking…' : 'Check for updates'}
        </Button>
      )}
    </Row>
  )
}
