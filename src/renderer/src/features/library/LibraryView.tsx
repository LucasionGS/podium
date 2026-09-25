import { useMemo } from 'react'
import { Clapperboard, Search } from 'lucide-react'
import { filterClips, sortClips, type ClipFilter, type ClipSort } from '@core/library/library'
import { Select } from '@/ui/Field'
import { dateGroup, formatBytes } from '@/lib/format'
import { useApp, type LibraryFilter } from '@/store/app'
import { useLibrary } from '@/store/library'
import { SetupCard } from '@/features/setup/SetupCard'
import { ClipCard } from './ClipCard'

const SORTS: Array<{ value: ClipSort; label: string }> = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'longest', label: 'Longest' },
  { value: 'largest', label: 'Largest' },
  { value: 'name', label: 'Name' }
]

function toClipFilter(filter: LibraryFilter, query: string): ClipFilter {
  return {
    gameId: typeof filter === 'object' ? filter.gameId : filter === 'desktop' ? 'desktop' : null,
    query,
    favorites: filter === 'favorites',
    bookmarks: filter === 'bookmarks'
  }
}

const TITLES: Record<Exclude<LibraryFilter, object>, string> = {
  all: 'All clips',
  favorites: 'Favorites',
  bookmarks: 'To review',
  desktop: 'Desktop'
}

export function LibraryView({ filter }: { filter: LibraryFilter }) {
  const clips = useLibrary((s) => s.clips)
  const games = useLibrary((s) => s.games)
  const loaded = useLibrary((s) => s.loaded)
  const query = useLibrary((s) => s.query)
  const sort = useLibrary((s) => s.sort)
  const problem = useApp((s) => s.capabilities?.problem)
  const clipHotkey = useApp((s) => s.settings?.hotkeys.find((h) => h.action.kind === 'clip')?.accelerator)

  const game = typeof filter === 'object' ? games.find((g) => g.id === filter.gameId) : undefined
  const title = typeof filter === 'object' ? (game?.name ?? 'Game') : TITLES[filter]
  const visible = useMemo(
    () => sortClips(filterClips(clips, toClipFilter(filter, query)), sort),
    [clips, filter, query, sort]
  )
  const sections = useMemo(() => {
    if (sort !== 'newest' && sort !== 'oldest') return [{ label: null, clips: visible }]
    const groups: Array<{ label: string | null; clips: typeof visible }> = []
    for (const clip of visible) {
      const label = dateGroup(clip.createdAt)
      const last = groups.at(-1)
      if (last?.label === label) last.clips.push(clip)
      else groups.push({ label, clips: [clip] })
    }
    return groups
  }, [visible, sort])
  const totalSize = visible.reduce((sum, c) => sum + c.size, 0)

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="relative shrink-0 overflow-hidden">
        {game?.heroUrl && (
          <>
            <img src={game.heroUrl} alt="" className="absolute inset-0 size-full object-cover opacity-45" />
            <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/70 to-bg/10" />
          </>
        )}
        <div className={`relative flex items-end gap-4 px-8 ${game?.heroUrl ? 'pt-24 pb-5' : 'pt-7 pb-4'}`}>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
            <p className="mt-1 text-xs text-muted">
              {visible.length} {visible.length === 1 ? 'clip' : 'clips'}
              {visible.length > 0 && ` · ${formatBytes(totalSize)}`}
            </p>
          </div>
          <label className="relative flex items-center">
            <Search size={14} className="pointer-events-none absolute left-2.5 text-faint" />
            <input
              type="search"
              value={query}
              onChange={(e) => useLibrary.setState({ query: e.target.value })}
              placeholder="Search clips"
              className="h-8 w-56 rounded-md border border-line bg-surface/80 pr-2 pl-8 text-xs outline-none placeholder:text-faint focus:border-accent"
            />
          </label>
          <Select
            aria-label="Sort"
            value={sort}
            onChange={(e) => useLibrary.setState({ sort: e.target.value as ClipSort })}
            className="h-8 w-36 flex-none bg-surface/80"
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </div>
      </header>

      <div className="flex flex-col gap-6 px-8 pb-10">
        {problem && filter === 'all' && <SetupCard />}
        {loaded && visible.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-20 text-center">
            <Clapperboard size={34} className="text-faint" />
            {clips.length === 0 ? (
              <>
                <p className="text-sm font-medium">No clips yet</p>
                <p className="max-w-sm text-xs leading-relaxed text-muted">
                  Podium keeps the last few minutes of your screen in memory. When something great happens,
                  press{' '}
                  <kbd className="rounded border border-line bg-raised px-1.5 py-0.5 text-2xs text-fg">
                    {clipHotkey ?? 'your clip hotkey'}
                  </kbd>{' '}
                  and it lands here.
                </p>
              </>
            ) : (
              <p className="text-sm text-muted">
                {query ? `Nothing matches “${query}”` : 'No clips here yet'}
              </p>
            )}
          </div>
        )}
        {sections.map((section) => (
          <section key={section.label ?? 'all'} aria-label={section.label ?? undefined}>
            {section.label && (
              <h2 className="mb-3 text-2xs font-semibold tracking-wider text-faint uppercase">
                {section.label}
              </h2>
            )}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-x-4 gap-y-5">
              {section.clips.map((clip) => (
                <ClipCard key={clip.id} clip={clip} showGame={typeof filter !== 'object'} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
