import { useEffect } from 'react'
import { ContextMenuHost } from '@/ui/ContextMenu'
import { ConfirmDialog, PromptDialog, Toasts } from '@/ui/Feedback'
import { LibraryView } from '@/features/library/LibraryView'
import { PlayerView } from '@/features/player/PlayerView'
import { SettingsView } from '@/features/settings/SettingsView'
import { useApp, wireApp } from '@/store/app'
import { wireExports } from '@/store/exports'
import { wireLibrary } from '@/store/library'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'

export function App() {
  const route = useApp((s) => s.route)
  const ready = useApp((s) => s.settings !== null)

  useEffect(() => {
    void wireApp()
    void wireLibrary()
    wireExports()
  }, [])

  if (!ready) return <Loading />
  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1">
          {route.view === 'library' && <LibraryView filter={route.filter} />}
          {route.view === 'clip' && <PlayerView key={route.clipId} clipId={route.clipId} />}
          {route.view === 'settings' && <SettingsView tab={route.tab} />}
        </div>
        <StatusBar />
      </main>
      <ContextMenuHost />
      <Toasts />
      <ConfirmDialog />
      <PromptDialog />
    </div>
  )
}

function Loading() {
  const error = useApp((s) => s.loadError)
  if (!error) return <div className="h-full bg-bg" />
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <h1 className="text-base font-semibold">Podium couldn’t load its settings</h1>
      <pre className="max-w-xl rounded-lg border border-line bg-surface p-3 text-left text-2xs text-faint select-text">
        {error}
      </pre>
      <button
        className="h-8 rounded-md bg-accent px-4 text-xs font-medium text-white hover:bg-accent-hover"
        onClick={() => location.reload()}
      >
        Try again
      </button>
    </div>
  )
}
