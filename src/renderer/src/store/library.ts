import { create } from 'zustand'
import type { ClipView, GameSummary } from '@shared/ipc'
import type { ClipSort } from '@core/library/library'

interface LibraryState {
  clips: ClipView[]
  games: GameSummary[]
  loaded: boolean
  query: string
  sort: ClipSort
}

export const useLibrary = create<LibraryState>(() => ({
  clips: [],
  games: [],
  loaded: false,
  query: '',
  sort: 'newest'
}))

async function refreshGames(): Promise<void> {
  useLibrary.setState({ games: await window.podium.library.games() })
}

let wired = false

export async function wireLibrary(): Promise<void> {
  if (wired) return
  wired = true
  window.podium.library.onChanged((clips) => {
    useLibrary.setState({ clips })
    void refreshGames()
  })
  const clips = await window.podium.library.list()
  useLibrary.setState({ clips, loaded: true })
  await refreshGames()
}

export const clipById = (id: string): ClipView | undefined =>
  useLibrary.getState().clips.find((c) => c.id === id)
