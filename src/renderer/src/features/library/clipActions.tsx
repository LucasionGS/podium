import { Download, FolderOpen, Pencil, Play, Star, Trash2 } from 'lucide-react'
import type { ClipView, ExportPreset } from '@shared/ipc'
import { PRESETS } from '@core/export/presets'
import { sanitizeFileName } from '@core/library/naming'
import type { MenuItem } from '@/ui/ContextMenu'
import { navigate, openLibrary, useApp } from '@/store/app'
import { startExport } from '@/store/exports'
import { confirm, promptText, toast } from '@/store/feedback'

export async function renameClip(clip: ClipView): Promise<void> {
  const title = await promptText({
    title: 'Rename clip',
    label: 'Name',
    value: clip.title,
    confirmLabel: 'Rename'
  })
  if (title && title !== clip.title) await window.podium.library.rename(clip.id, title)
}

export const toggleFavorite = (clip: ClipView): Promise<void> =>
  window.podium.library.setFlags(clip.id, { favorite: !clip.favorite })

export async function deleteClips(clips: ClipView[]): Promise<boolean> {
  const one = clips.length === 1
  const answer = await confirm({
    title: one ? 'Delete clip?' : `Delete ${clips.length} clips?`,
    message: one
      ? `“${clips[0]!.title}” is moved to the trash.`
      : 'The clips are moved to the trash, so you can still restore them from there.',
    confirmLabel: 'Delete',
    danger: true
  })
  if (answer !== 'confirm') return false
  await window.podium.library.remove(clips.map((c) => c.id))
  const route = useApp.getState().route
  if (route.view === 'clip' && clips.some((c) => c.id === route.clipId)) openLibrary()
  return true
}

/** Exports to a file the user picks (Discord, GIF…). */
export async function exportClip(
  clip: ClipView,
  preset: ExportPreset,
  range = { start: 0, end: clip.duration },
  volumes = clip.audioTracks.map(() => 1)
): Promise<void> {
  const extension = PRESETS[preset].extension
  const suffix = preset === 'discord' ? ' (Discord)' : preset === 'gif' ? '' : ' (export)'
  const path = await window.podium.dialog.saveFile(`${sanitizeFileName(clip.title)}${suffix}.${extension}`, [
    extension
  ])
  if (!path) return
  await startExport({ clipId: clip.id, preset, range, volumes, destination: { path } })
  toast(`Exporting “${clip.title}”…`)
}

export function clipMenu(clip: ClipView): MenuItem[] {
  return [
    { label: 'Open', icon: <Play size={13} />, onSelect: () => navigate({ view: 'clip', clipId: clip.id }) },
    { label: 'Rename…', icon: <Pencil size={13} />, onSelect: () => void renameClip(clip) },
    {
      label: clip.favorite ? 'Remove from favorites' : 'Add to favorites',
      icon: <Star size={13} />,
      onSelect: () => void toggleFavorite(clip)
    },
    {
      type: 'submenu',
      label: 'Export',
      icon: <Download size={13} />,
      items: (Object.keys(PRESETS) as ExportPreset[]).map((preset) => ({
        label: `${PRESETS[preset].label}…`,
        onSelect: () => void exportClip(clip, preset)
      }))
    },
    {
      label: 'Show in folder',
      icon: <FolderOpen size={13} />,
      onSelect: () => window.podium.library.reveal(clip.id)
    },
    { type: 'separator' },
    { label: 'Delete', icon: <Trash2 size={13} />, danger: true, onSelect: () => void deleteClips([clip]) }
  ]
}
