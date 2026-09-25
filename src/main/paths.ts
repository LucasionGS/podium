import { join } from 'node:path'
import { app } from 'electron'
import { getSettings } from './settings'

/** Where clips are saved. `PODIUM_LIBRARY_DIR` overrides it for tests. */
export async function libraryDir(): Promise<string> {
  const override = process.env['PODIUM_LIBRARY_DIR']
  if (override) return override
  return (await getSettings()).libraryDir ?? join(app.getPath('videos'), 'Podium')
}

/**
 * Where the backend writes saved replays before they are filed. It sits inside the library so the
 * final move is a rename on the same disk (a disk-backed replay buffer lives here too).
 */
export const stagingDir = async (): Promise<string> => join(await libraryDir(), '.podium')

export const cacheRoot = (): string => join(app.getPath('userData'), 'cache')
