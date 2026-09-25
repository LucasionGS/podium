import { useEffect, useRef, useState } from 'react'
import { Bookmark, Star } from 'lucide-react'
import type { ClipView } from '@shared/ipc'
import { openContextMenu } from '@/ui/ContextMenu'
import { formatBytes, formatDuration, formatRelative } from '@/lib/format'
import { navigate } from '@/store/app'
import { clipMenu, toggleFavorite } from './clipActions'

/** Hovering plays the clip muted after a short delay, so sweeping across the grid doesn't start every video. */
function useHoverPreview(): { hovering: boolean; bind: { onPointerEnter(): void; onPointerLeave(): void } } {
  const [hovering, setHovering] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return {
    hovering,
    bind: {
      onPointerEnter: () => {
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setHovering(true), 350)
      },
      onPointerLeave: () => {
        window.clearTimeout(timer.current)
        setHovering(false)
      }
    }
  }
}

export function ClipCard({ clip, showGame }: { clip: ClipView; showGame: boolean }) {
  const { hovering, bind } = useHoverPreview()
  const [thumbFailed, setThumbFailed] = useState(false)
  const open = (): void => navigate({ view: 'clip', clipId: clip.id })

  return (
    <article
      className="group flex min-w-0 flex-col gap-2"
      onContextMenu={(e) => openContextMenu(e, clipMenu(clip))}
      {...bind}
    >
      <button
        type="button"
        onClick={open}
        draggable
        onDragStart={(e) => {
          // The OS drag carries the real file, so it can be dropped into Discord or a file manager.
          e.preventDefault()
          window.podium.library.startDrag(clip.id)
        }}
        aria-label={`Play ${clip.title}`}
        className="relative aspect-video w-full overflow-hidden rounded-lg border border-line bg-raised transition-[border-color,transform] duration-150 group-hover:border-faint"
      >
        {clip.thumbnailUrl && !thumbFailed && (
          <img
            src={clip.thumbnailUrl}
            alt=""
            loading="lazy"
            draggable={false}
            onError={() => setThumbFailed(true)}
            className="absolute inset-0 size-full object-cover"
          />
        )}
        {hovering && (
          <video
            src={clip.url}
            muted
            autoPlay
            loop
            playsInline
            preload="auto"
            className="absolute inset-0 size-full object-cover"
          />
        )}
        <span className="absolute right-1.5 bottom-1.5 rounded bg-black/75 px-1.5 py-0.5 text-2xs font-medium text-white tabular-nums">
          {formatDuration(clip.duration)}
        </span>
        {clip.bookmark && (
          <span className="absolute top-1.5 left-1.5 flex items-center gap-1 rounded bg-warn/90 px-1.5 py-0.5 text-2xs font-semibold text-black">
            <Bookmark size={10} /> Review
          </span>
        )}
      </button>
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={open}
            className="block max-w-full truncate text-left text-[13px] font-medium hover:underline"
          >
            {clip.title}
          </button>
          <p className="truncate text-2xs text-faint">
            {showGame && `${clip.gameName ?? 'Desktop'} · `}
            {formatRelative(clip.createdAt)} · {formatBytes(clip.size)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void toggleFavorite(clip)}
          aria-label={clip.favorite ? 'Remove from favorites' : 'Add to favorites'}
          aria-pressed={clip.favorite}
          className={`mt-0.5 shrink-0 transition-opacity ${
            clip.favorite ? 'text-warn' : 'text-faint opacity-0 group-hover:opacity-100 hover:text-fg'
          }`}
        >
          <Star size={14} fill={clip.favorite ? 'currentColor' : 'none'} />
        </button>
      </div>
    </article>
  )
}
