import { create } from 'zustand'
import type {
  AppInfo,
  AppSettings,
  CaptureCapabilities,
  CaptureStatus,
  ClipAction,
  DetectedGame,
  HotkeyStatus
} from '@shared/ipc'
import { playCue } from '@/lib/cue'
import { toast } from './feedback'

export type Route =
  | { view: 'library'; filter: LibraryFilter }
  | { view: 'clip'; clipId: string }
  | { view: 'settings'; tab: SettingsTab }

/** Sidebar sections: every clip, favourites, bookmarks to review, one game, or clips without a game. */
export type LibraryFilter = 'all' | 'favorites' | 'bookmarks' | 'desktop' | { gameId: string }

export type SettingsTab = 'recording' | 'audio' | 'hotkeys' | 'library' | 'games' | 'general'

interface AppState {
  route: Route
  /** Where "back" from the player goes. */
  lastLibraryFilter: LibraryFilter
  settings: AppSettings | null
  capabilities: CaptureCapabilities | null
  status: CaptureStatus | null
  game: DetectedGame | null
  hotkeys: HotkeyStatus | null
  info: AppInfo | null
  /** Set when the first load failed, so the window shows why instead of staying blank. */
  loadError: string | null
}

export const useApp = create<AppState>(() => ({
  route: { view: 'library', filter: 'all' },
  lastLibraryFilter: 'all',
  settings: null,
  capabilities: null,
  status: null,
  game: null,
  hotkeys: null,
  info: null,
  loadError: null
}))

export function navigate(route: Route): void {
  useApp.setState((s) => ({
    route,
    lastLibraryFilter: route.view === 'library' ? route.filter : s.lastLibraryFilter
  }))
}

export const openLibrary = (filter?: LibraryFilter): void =>
  navigate({ view: 'library', filter: filter ?? useApp.getState().lastLibraryFilter })

export async function updateSettings(patch: Partial<AppSettings>): Promise<void> {
  // Optimistic, so sliders and toggles respond instantly; main's answer is the truth.
  useApp.setState((s) => ({ settings: s.settings ? { ...s.settings, ...patch } : s.settings }))
  const settings = await window.podium.settings.update(patch)
  useApp.setState({ settings })
  if (patch.hotkeys) useApp.setState({ hotkeys: await window.podium.hotkeys.status() })
}

export async function refreshCapabilities(): Promise<void> {
  const capabilities = await window.podium.capture.capabilities(true)
  useApp.setState({ capabilities })
  const state = useApp.getState().status?.state
  if (!capabilities.problem && (state === 'unavailable' || state === 'off' || state === 'error')) {
    await window.podium.capture.start()
  }
}

export async function saveClip(action: ClipAction): Promise<void> {
  const clip = await window.podium.capture.save(action)
  if (!clip) toast('The replay buffer is not running', 'error')
}

let wired = false

/** Loads the initial state and subscribes to main's updates (once per page). */
export async function wireApp(): Promise<void> {
  if (wired) return
  wired = true
  const api = window.podium
  api.capture.onStatus((status) => useApp.setState({ status }))
  api.games.onChanged((game) => useApp.setState({ game }))
  api.app.onPlayCue(() => playCue(useApp.getState().settings?.notifications.soundVolume ?? 0.6))
  api.app.onNavigate((route) => {
    const clip = /^clip\/(.+)$/.exec(route)
    if (clip) navigate({ view: 'clip', clipId: clip[1]! })
  })
  // Each piece loads on its own; only settings are essential to render.
  const settle = <T>(promise: Promise<T>, fallback: T): Promise<T> =>
    promise.catch((error: unknown) => {
      console.error(error)
      return fallback
    })
  const [capabilities, status, game, hotkeys, info] = await Promise.all([
    settle(api.capture.capabilities(), null),
    settle(api.capture.status(), null),
    settle(api.games.current(), null),
    settle(api.hotkeys.status(), null),
    settle(api.app.info(), null)
  ])
  useApp.setState({ capabilities, status, game, hotkeys, info })
  try {
    useApp.setState({ settings: await api.settings.get(), loadError: null })
  } catch (error) {
    useApp.setState({ loadError: error instanceof Error ? error.message : String(error) })
  }
}
