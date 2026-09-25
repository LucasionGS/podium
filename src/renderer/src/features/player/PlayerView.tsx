import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  Bookmark,
  Download,
  FolderOpen,
  Mic,
  Pause,
  Play,
  RotateCcw,
  Save,
  Speaker,
  Star,
  Trash2,
  Volume2,
  VolumeX,
  X
} from 'lucide-react'
import type { ClipView, ExportPreset, Filmstrip } from '@shared/ipc'
import { PRESETS } from '@core/export/presets'
import { Button } from '@/ui/Button'
import { IconButton } from '@/ui/IconButton'
import { formatBytes, formatDuration, formatPrecise } from '@/lib/format'
import { openLibrary } from '@/store/app'
import { startExport, useExports } from '@/store/exports'
import { confirm, toast } from '@/store/feedback'
import { useLibrary } from '@/store/library'
import { deleteClips, exportClip, renameClip, toggleFavorite } from '@/features/library/clipActions'
import { TrimBar } from './TrimBar'
import { useTrackMixer } from './useTrackMixer'

export function PlayerView({ clipId }: { clipId: string }) {
  const clip = useLibrary((s) => s.clips.find((c) => c.id === clipId))
  const loaded = useLibrary((s) => s.loaded)
  if (!clip) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted">
        {loaded ? 'This clip no longer exists.' : 'Loading…'}
        <Button onClick={() => openLibrary()}>Back to clips</Button>
      </div>
    )
  }
  // Remount when the file changes (a trim replaced it), so all state starts fresh.
  return <Player key={`${clip.id}:${clip.size}`} clip={clip} />
}

function Player({ clip }: { clip: ClipView }) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  // Bookmarks hold the whole buffer; start with the last 30 seconds selected, where the moment usually is.
  const [range, setRange] = useState(() => ({
    start: clip.bookmark ? Math.max(0, clip.duration - 30) : 0,
    end: clip.duration
  }))
  const [volumes, setVolumes] = useState(() => clip.audioTracks.map(() => 1))
  const [filmstrip, setFilmstrip] = useState<Filmstrip | null>(null)
  const mixing = useTrackMixer(clip, video, volumes)
  const game = useLibrary((s) => s.games.find((g) => g.id === clip.gameId))

  useEffect(() => {
    let cancelled = false
    void window.podium.library.filmstrip(clip.id).then((f) => !cancelled && setFilmstrip(f))
    return () => {
      cancelled = true
    }
  }, [clip.id])

  const seek = useCallback(
    (t: number) => {
      if (!video) return
      video.currentTime = Math.max(0, Math.min(clip.duration, t))
      setTime(video.currentTime)
    },
    [video, clip.duration]
  )

  const togglePlay = useCallback(() => {
    if (!video) return
    if (video.paused) {
      // Playing from outside the selection starts at its beginning.
      if (video.currentTime < range.start || video.currentTime >= range.end - 0.05)
        video.currentTime = range.start
      void video.play()
    } else video.pause()
  }, [video, range])

  // Playback loops inside the selection; the timeline updates at display rate for a smooth playhead.
  useEffect(() => {
    if (!video) return
    let frame = 0
    const tick = (): void => {
      setTime(video.currentTime)
      if (!video.paused && video.currentTime >= range.end) video.currentTime = range.start
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [video, range])

  useEffect(() => {
    if (video && clip.bookmark) video.currentTime = range.start
    // Only on load: later trims must not jump the playhead.
  }, [video])

  // Keyboard: space/K play, J/L ±5 s, arrows ±1 s (shift: one frame), I/O set in/out, Esc back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (!video) return
      const frame = 1 / (clip.fps || 60)
      const handled = (() => {
        switch (e.key) {
          case ' ':
          case 'k':
            togglePlay()
            return true
          case 'j':
            seek(video.currentTime - 5)
            return true
          case 'l':
            seek(video.currentTime + 5)
            return true
          case 'ArrowLeft':
            seek(video.currentTime - (e.shiftKey ? frame : 1))
            return true
          case 'ArrowRight':
            seek(video.currentTime + (e.shiftKey ? frame : 1))
            return true
          case 'i':
            setRange((r) => ({ ...r, start: Math.min(video.currentTime, r.end - 0.5) }))
            return true
          case 'o':
            setRange((r) => ({ ...r, end: Math.max(video.currentTime, r.start + 0.5) }))
            return true
          case 'Escape':
            openLibrary()
            return true
          default:
            return false
        }
      })()
      if (handled) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [video, clip.fps, seek, togglePlay])

  const trimmed = range.start > 0.05 || range.end < clip.duration - 0.05
  const mixed = volumes.some((v) => v !== 1)

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
          <IconButton label="Back to clips" onClick={() => openLibrary()}>
            <ArrowLeft size={16} />
          </IconButton>
          <div className="min-w-0 flex-1">
            <button
              type="button"
              className="block max-w-full truncate text-left text-sm font-semibold hover:underline"
              title="Rename"
              onClick={() => void renameClip(clip)}
            >
              {clip.title}
            </button>
            <p className="flex items-center gap-1.5 truncate text-2xs text-muted">
              {game?.iconUrl && <img src={game.iconUrl} alt="" className="size-3.5 rounded-sm" />}
              {clip.gameName ?? 'Desktop'} · {new Date(clip.createdAt).toLocaleString()}
            </p>
          </div>
          <IconButton
            label={clip.favorite ? 'Remove from favorites' : 'Add to favorites'}
            active={clip.favorite}
            onClick={() => void toggleFavorite(clip)}
          >
            <Star size={15} fill={clip.favorite ? 'currentColor' : 'none'} />
          </IconButton>
          <IconButton label="Show in folder" onClick={() => window.podium.library.reveal(clip.id)}>
            <FolderOpen size={15} />
          </IconButton>
          <IconButton label="Delete" onClick={() => void deleteClips([clip])}>
            <Trash2 size={15} />
          </IconButton>
        </header>

        <div
          className="relative flex min-h-0 flex-1 items-center justify-center bg-black"
          onClick={togglePlay}
        >
          <video
            ref={setVideo}
            src={clip.url}
            className="max-h-full max-w-full"
            preload="auto"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onDragStart={(e) => {
              e.preventDefault()
              window.podium.library.startDrag(clip.id)
            }}
            draggable
          />
          {!playing && (
            <span className="pointer-events-none absolute flex size-16 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur">
              <Play size={28} fill="currentColor" className="ml-1" />
            </span>
          )}
        </div>

        <div className="shrink-0 border-t border-line bg-surface px-5 pt-3 pb-2">
          <div className="mb-2.5 flex items-center gap-3">
            <IconButton label={playing ? 'Pause (Space)' : 'Play (Space)'} onClick={togglePlay}>
              {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
            </IconButton>
            <span className="text-xs tabular-nums">
              {formatPrecise(time)} <span className="text-faint">/ {formatPrecise(clip.duration)}</span>
            </span>
            <span className="ml-auto text-xs text-muted tabular-nums">
              Selection {formatPrecise(range.end - range.start)}
            </span>
            <Button
              variant="ghost"
              onClick={() => setRange((r) => ({ ...r, start: Math.min(time, r.end - 0.5) }))}
              title="Set start (I)"
            >
              Set start
            </Button>
            <Button
              variant="ghost"
              onClick={() => setRange((r) => ({ ...r, end: Math.max(time, r.start + 0.5) }))}
              title="Set end (O)"
            >
              Set end
            </Button>
            <IconButton
              label="Reset trim"
              disabled={!trimmed}
              onClick={() => setRange({ start: 0, end: clip.duration })}
            >
              <RotateCcw size={14} />
            </IconButton>
          </div>
          <TrimBar
            duration={clip.duration}
            start={range.start}
            end={range.end}
            time={time}
            filmstrip={filmstrip}
            onTrim={(start, end) => setRange({ start, end })}
            onSeek={seek}
          />
        </div>
      </div>

      <SidePanel
        clip={clip}
        range={range}
        volumes={volumes}
        setVolumes={setVolumes}
        mixing={mixing}
        edited={trimmed || mixed}
      />
    </div>
  )
}

function SidePanel({
  clip,
  range,
  volumes,
  setVolumes,
  mixing,
  edited
}: {
  clip: ClipView
  range: { start: number; end: number }
  volumes: number[]
  setVolumes: (v: number[]) => void
  mixing: boolean
  edited: boolean
}) {
  const jobs = useExports((s) => s.jobs)
  const active = useMemo(
    () => jobs.filter((j) => j.clipId === clip.id && (j.state === 'running' || j.state === 'queued')),
    [jobs, clip.id]
  )

  const save = async (destination: 'library' | 'replace'): Promise<void> => {
    if (destination === 'replace') {
      const answer = await confirm({
        title: 'Replace the original?',
        message: 'The clip is overwritten with the trimmed version. This can’t be undone.',
        confirmLabel: 'Replace',
        danger: true
      })
      if (answer !== 'confirm') return
    }
    await startExport({ clipId: clip.id, preset: 'tracks', range, volumes, destination })
    toast(destination === 'replace' ? 'Trimming the clip…' : 'Saving a trimmed copy…')
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-line bg-surface">
      {clip.bookmark && (
        <Section title="Bookmark">
          <p className="text-xs leading-relaxed text-muted">
            Saved from the whole replay buffer. Trim it to the moment and save, or keep it as it is.
          </p>
          <Button
            className="mt-2.5"
            onClick={() => void window.podium.library.setFlags(clip.id, { bookmark: false })}
          >
            <Bookmark size={13} />
            Mark as reviewed
          </Button>
        </Section>
      )}

      <Section title="Audio">
        {clip.audioTracks.length === 0 && <p className="text-xs text-faint">This clip has no audio.</p>}
        {clip.audioTracks.map((label, i) => (
          <TrackSlider
            key={i}
            label={label}
            value={volumes[i] ?? 1}
            onChange={(v) => setVolumes(volumes.map((old, j) => (j === i ? v : old)))}
          />
        ))}
        {clip.audioTracks.length > 1 && !mixing && (
          <p className="mt-1 text-2xs text-faint">Preparing tracks for mixing…</p>
        )}
      </Section>

      <Section title="Save">
        <div className="flex flex-col gap-2">
          <Button
            variant="primary"
            disabled={!edited}
            onClick={() => void save('library')}
            className="justify-center"
          >
            <Save size={13} />
            Save as new clip
          </Button>
          <Button disabled={!edited} onClick={() => void save('replace')} className="justify-center">
            Trim original
          </Button>
          {!edited && (
            <p className="text-2xs leading-relaxed text-faint">
              Trim the clip or change a track’s volume first.
            </p>
          )}
        </div>
      </Section>

      <Section title="Export">
        <div className="flex flex-col gap-1">
          {(Object.keys(PRESETS) as ExportPreset[]).map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => void exportClip(clip, preset, range, volumes)}
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-hover"
            >
              <Download size={14} className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium">{PRESETS[preset].label}</span>
                <span className="block text-2xs text-faint">{PRESETS[preset].hint}</span>
              </span>
            </button>
          ))}
        </div>
        {active.map((job) => (
          <div key={job.id} className="mt-2 rounded-md border border-line bg-bg p-2.5">
            <div className="flex items-center gap-2 text-2xs">
              <span className="min-w-0 flex-1 truncate">{job.name}</span>
              <span className="text-muted tabular-nums">{Math.round(job.progress * 100)}%</span>
              <button
                className="text-faint hover:text-fg"
                aria-label="Cancel"
                onClick={() => window.podium.exports.cancel(job.id)}
              >
                <X size={12} />
              </button>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded bg-line">
              <div
                className="h-full bg-accent transition-[width]"
                style={{ width: `${job.progress * 100}%` }}
              />
            </div>
          </div>
        ))}
      </Section>

      <Section title="Details">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
          <Detail label="Length">{formatDuration(clip.duration)}</Detail>
          <Detail label="Video">
            {clip.width}×{clip.height} · {clip.fps} fps
          </Detail>
          <Detail label="Size">{formatBytes(clip.size)}</Detail>
          <Detail label="Tracks">{clip.audioTracks.join(', ') || 'None'}</Detail>
        </dl>
        <p className="mt-3 text-2xs leading-relaxed break-all text-faint select-text">{clip.path}</p>
      </Section>
    </aside>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-line p-4">
      <h2 className="mb-2.5 text-2xs font-semibold tracking-wider text-muted uppercase">{title}</h2>
      {children}
    </section>
  )
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-faint">{label}</dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </>
  )
}

function TrackSlider({
  label,
  value,
  onChange
}: {
  label: string
  value: number
  onChange: (v: number) => void
}) {
  const muted = value === 0
  const Icon = label === 'Microphone' ? Mic : label === 'Desktop' ? Speaker : Volume2
  return (
    <div className="flex items-center gap-2 py-1">
      <Icon size={14} className="shrink-0 text-muted" />
      <span className="w-20 shrink-0 truncate text-xs">{label}</span>
      <input
        type="range"
        min={0}
        max={2}
        step={0.05}
        value={value}
        aria-label={`${label} volume`}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-w-0 flex-1"
      />
      <button
        type="button"
        className={`w-9 shrink-0 text-right text-2xs tabular-nums ${muted ? 'text-danger' : 'text-muted hover:text-fg'}`}
        title={muted ? 'Unmute' : 'Mute'}
        onClick={() => onChange(muted ? 1 : 0)}
      >
        {muted ? <VolumeX size={13} className="ml-auto" /> : `${Math.round(value * 100)}%`}
      </button>
    </div>
  )
}
