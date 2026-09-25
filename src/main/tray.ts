import { join } from 'node:path'
import { app, Menu, nativeImage, Tray } from 'electron'
import type { CaptureStatus, ClipAction } from '@shared/ipc'

export interface TrayActions {
  save(action: ClipAction): void
  toggleBuffer(): void
  show(): void
  quit(): void
}

const resource = (name: string): string =>
  app.isPackaged ? join(process.resourcesPath, name) : join(app.getAppPath(), 'resources', name)

const STATE_LABELS: Record<CaptureStatus['state'], string> = {
  off: 'Replay buffer off',
  starting: 'Starting replay buffer…',
  buffering: 'Replay buffer on',
  paused: 'Replay buffer paused',
  error: 'Replay buffer stopped (error)',
  unavailable: 'Recording unavailable'
}

export class PodiumTray {
  private tray: Tray | null = null

  constructor(private readonly actions: TrayActions) {}

  create(status: CaptureStatus): void {
    const icon = nativeImage.createFromPath(resource(process.platform === 'win32' ? 'icon.png' : 'tray.png'))
    this.tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 22, height: 22 }))
    this.tray.setToolTip('Podium')
    this.tray.on('click', () => this.actions.show())
    this.update(status)
  }

  update(status: CaptureStatus): void {
    if (!this.tray) return
    const buffering = status.state === 'buffering'
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: STATE_LABELS[status.state], enabled: false },
        { type: 'separator' },
        {
          label: 'Save last 30 seconds',
          enabled: buffering,
          click: () => this.actions.save({ kind: 'clip', seconds: 30 })
        },
        {
          label: 'Save whole buffer',
          enabled: buffering,
          click: () => this.actions.save({ kind: 'bookmark' })
        },
        { type: 'separator' },
        {
          label: buffering || status.state === 'starting' ? 'Stop replay buffer' : 'Start replay buffer',
          enabled: status.state !== 'unavailable',
          click: () => this.actions.toggleBuffer()
        },
        { label: 'Open Podium', click: () => this.actions.show() },
        { type: 'separator' },
        { label: 'Quit Podium', click: () => this.actions.quit() }
      ])
    )
  }

  get exists(): boolean {
    return this.tray !== null
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }
}
