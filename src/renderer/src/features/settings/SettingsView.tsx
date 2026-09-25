import type { ReactNode } from 'react'
import { Gamepad2, HardDrive, Keyboard, Settings2, Video, Volume2 } from 'lucide-react'
import { navigate, type SettingsTab } from '@/store/app'
import { AudioSettings } from './AudioSettings'
import { GamesSettings } from './GamesSettings'
import { GeneralSettings } from './GeneralSettings'
import { HotkeySettings } from './HotkeySettings'
import { LibrarySettings } from './LibrarySettings'
import { RecordingSettings } from './RecordingSettings'

const TABS: Array<{ id: SettingsTab; label: string; icon: ReactNode }> = [
  { id: 'recording', label: 'Recording', icon: <Video size={15} /> },
  { id: 'audio', label: 'Audio', icon: <Volume2 size={15} /> },
  { id: 'hotkeys', label: 'Hotkeys', icon: <Keyboard size={15} /> },
  { id: 'library', label: 'Library', icon: <HardDrive size={15} /> },
  { id: 'games', label: 'Games', icon: <Gamepad2 size={15} /> },
  { id: 'general', label: 'General', icon: <Settings2 size={15} /> }
]

export function SettingsView({ tab }: { tab: SettingsTab }) {
  return (
    <div className="flex h-full">
      <nav className="w-48 shrink-0 border-r border-line p-3" aria-label="Settings">
        <h1 className="mb-3 px-2 pt-2 text-lg font-semibold tracking-tight">Settings</h1>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-current={t.id === tab || undefined}
            onClick={() => navigate({ view: 'settings', tab: t.id })}
            className={`flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] ${
              t.id === tab ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-hover hover:text-fg'
            }`}
          >
            <span className={t.id === tab ? 'text-accent' : ''}>{t.icon}</span>
            {t.label}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 py-8">
          {tab === 'recording' && <RecordingSettings />}
          {tab === 'audio' && <AudioSettings />}
          {tab === 'hotkeys' && <HotkeySettings />}
          {tab === 'library' && <LibrarySettings />}
          {tab === 'games' && <GamesSettings />}
          {tab === 'general' && <GeneralSettings />}
        </div>
      </div>
    </div>
  )
}
