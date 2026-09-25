import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { AppSettings } from '@shared/ipc'
import { normalizeSettings } from '@core/settings'
import { setCustomFfmpegDir } from './ffmpeg/paths'

let settings: AppSettings | null = null
const file = (): string => join(app.getPath('userData'), 'settings.json')
const listeners = new Set<(next: AppSettings, previous: AppSettings) => void>()

/** Write-then-rename so a crash mid-write can never leave a half-written file. */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, data)
  await rename(temp, path)
}

export async function getSettings(): Promise<AppSettings> {
  if (settings) return settings
  try {
    settings = normalizeSettings(JSON.parse(await readFile(file(), 'utf8')))
  } catch {
    settings = normalizeSettings({})
  }
  setCustomFfmpegDir(settings.ffmpegDir)
  return settings
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const previous = await getSettings()
  settings = normalizeSettings({ ...previous, ...patch })
  setCustomFfmpegDir(settings.ffmpegDir)
  await writeFileAtomic(file(), JSON.stringify(settings, null, 2))
  for (const listener of listeners) listener(settings, previous)
  return settings
}

export function onSettingsChanged(listener: (next: AppSettings, previous: AppSettings) => void): void {
  listeners.add(listener)
}
