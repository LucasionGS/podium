import type { ClipAction, UploadProtocolKind, UploadSettings, UploadTarget } from '@shared/ipc'

export const PROTOCOLS: Record<UploadProtocolKind, { label: string; hint: string }> = {
  podium: {
    label: 'Podium-compatible server',
    hint: 'Your own server, or any service that speaks the open Podium upload protocol.'
  }
}

/** The target an upload goes to: the one asked for, else the default, else the first. Null when none is set up. */
export function resolveTarget(settings: UploadSettings, id?: string | null): UploadTarget | null {
  const find = (want: string | null | undefined): UploadTarget | undefined =>
    want ? settings.targets.find((t) => t.id === want) : undefined
  if (id) return find(id) ?? null
  return find(settings.defaultTarget) ?? settings.targets[0] ?? null
}

/**
 * Where a freshly saved clip is uploaded automatically, or null when it isn't. Bookmarks hold the whole
 * buffer and are meant to be trimmed first, so they're never uploaded on their own.
 */
export function autoUploadTarget(settings: UploadSettings, action: ClipAction): UploadTarget | null {
  if (!settings.auto || action.kind !== 'clip') return null
  return resolveTarget(settings)
}
