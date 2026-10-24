import type { Clip, UploadTarget, UploadTestResult } from '@shared/ipc'
import type { RemoteClip } from '@core/upload/protocol'

/** One clip file to upload, with the hooks the queue uses to show progress. */
export interface UploadRequest {
  clip: Clip
  path: string
  fileName: string
  size: number
  sha256: string
  /** The target's saved token, or null when it has none. */
  token: string | null
  signal: AbortSignal
  /** Bytes the server has (or is receiving) so far. */
  onProgress(sent: number): void
  /** `finishing` once every byte is sent and the server is accepting the clip. */
  onState(state: 'uploading' | 'finishing'): void
  /** Explains a wait (a retry countdown); cleared with null. */
  onMessage(message: string | null): void
}

/**
 * Something that can upload clips to one kind of target. The Podium protocol is the first; others
 * (YouTube…) implement this too, and the queue doesn't need to know which one it's talking to.
 */
export interface UploadProtocol<T extends UploadTarget = UploadTarget> {
  /** Checks that the target is reachable and the token works, for Settings → Uploads. */
  test(target: T, token: string | null): Promise<UploadTestResult>
  /** Uploads the file and resolves with where it ended up; rejects with a readable error. */
  upload(target: T, request: UploadRequest): Promise<RemoteClip>
}
