import { join } from 'node:path'
import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
import type { CaptureStatus, ClipAction, UpdateStatus } from '@shared/ipc'

export interface TrayActions {
  save(action: ClipAction): void
  toggleBuffer(): void
  show(): void
  /** Opens Settings on the update. */
  showUpdate(): void
  restartToUpdate(): void
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
  private status: CaptureStatus | null = null
  private updateStatus: UpdateStatus | null = null

  constructor(private readonly actions: TrayActions) {}

  create(status: CaptureStatus): void {
    const icon = nativeImage.createFromPath(resource(process.platform === 'win32' ? 'icon.png' : 'tray.png'))
    this.tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 22, height: 22 }))
    this.tray.setToolTip('Podium')
    this.tray.on('click', () => this.actions.show())
    this.update(status)
  }

  setUpdate(status: UpdateStatus): void {
    this.updateStatus = status
    if (this.status) this.update(this.status)
  }

  private updateItems(): MenuItemConstructorOptions[] {
    const update = this.updateStatus
    if (update?.state === 'ready')
      return [
        {
          label: `Restart to update to ${update.available?.version}`,
          click: () => this.actions.restartToUpdate()
        }
      ]
    if (update?.available && update.state !== 'up-to-date')
      return [
        { label: `Podium ${update.available.version} is available…`, click: () => this.actions.showUpdate() }
      ]
    return []
  }

  update(status: CaptureStatus): void {
    this.status = status
    if (!this.tray) return
    const updates = this.updateItems()
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
        ...updates,
        ...(updates.length ? [{ type: 'separator' as const }] : []),
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
