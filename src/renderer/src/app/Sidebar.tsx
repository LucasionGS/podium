import type { ReactNode } from 'react'
import { Bookmark, Film, Monitor, Settings, Star } from 'lucide-react'
import { navigate, useApp, type LibraryFilter } from '@/store/app'
import { useLibrary } from '@/store/library'
import { Logo } from './Logo'

const sameFilter = (a: LibraryFilter, b: LibraryFilter): boolean =>
  typeof a === 'string' || typeof b === 'string' ? a === b : a.gameId === b.gameId

export function Sidebar() {
  const route = useApp((s) => s.route)
  const clips = useLibrary((s) => s.clips)
  const games = useLibrary((s) => s.games)
  const lastFilter = useApp((s) => s.lastLibraryFilter)
  const active = route.view === 'library' ? route.filter : route.view === 'clip' ? lastFilter : null
  const favorites = clips.filter((c) => c.favorite).length
  const bookmarks = clips.filter((c) => c.bookmark).length
  const desktop = clips.filter((c) => !c.gameId).length

  const item = (filter: LibraryFilter, icon: ReactNode, label: string, count: number) => (
    <SidebarItem
      key={typeof filter === 'string' ? filter : filter.gameId}
      icon={icon}
      label={label}
      count={count}
      active={active !== null && sameFilter(active, filter)}
      onClick={() => navigate({ view: 'library', filter })}
    />
  )

  return (
    <nav className="flex w-60 shrink-0 flex-col border-r border-line bg-surface" aria-label="Library">
      <div className="flex h-14 shrink-0 items-center gap-2.5 px-4">
        <Logo />
        <span className="text-[15px] font-semibold tracking-tight">Podium</span>
      </div>

      <div className="flex flex-col gap-0.5 px-2">
        {item('all', <Film size={15} />, 'All clips', clips.length)}
        {item('favorites', <Star size={15} />, 'Favorites', favorites)}
        {bookmarks > 0 && item('bookmarks', <Bookmark size={15} />, 'To review', bookmarks)}
      </div>

      <h2 className="mt-5 mb-1.5 px-4 text-2xs font-semibold tracking-wider text-faint uppercase">Games</h2>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
        {games.map((game) =>
          item(
            { gameId: game.id },
            game.iconUrl ? (
              <img src={game.iconUrl} alt="" className="size-[18px] rounded-[4px] object-cover" />
            ) : (
              <span className="flex size-[18px] items-center justify-center rounded-[4px] bg-hover text-[10px] font-semibold text-muted">
                {game.name.slice(0, 1).toUpperCase()}
              </span>
            ),
            game.name,
            game.clipCount
          )
        )}
        {desktop > 0 && item('desktop', <Monitor size={15} />, 'Desktop', desktop)}
        {games.length === 0 && desktop === 0 && (
          <p className="px-2 text-2xs leading-relaxed text-faint">Games you clip show up here.</p>
        )}
      </div>

      <div className="border-t border-line p-2">
        <SidebarItem
          icon={<Settings size={15} />}
          label="Settings"
          active={route.view === 'settings'}
          onClick={() => navigate({ view: 'settings', tab: 'recording' })}
        />
      </div>
    </nav>
  )
}

function SidebarItem({
  icon,
  label,
  count,
  active,
  onClick
}: {
  icon: ReactNode
  label: string
  count?: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active || undefined}
      className={`flex h-8 w-full shrink-0 items-center gap-2.5 rounded-md px-2 text-left text-[13px] transition-colors ${
        active ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-hover hover:text-fg'
      }`}
    >
      <span className={`flex w-[18px] shrink-0 justify-center ${active ? 'text-accent' : ''}`}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && count > 0 && <span className="text-2xs text-faint tabular-nums">{count}</span>}
    </button>
  )
}
