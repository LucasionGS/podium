import { useEffect, useRef, useState } from 'react'
import type { ClipView } from '@shared/ipc'

/** Drift (seconds) tolerated between the video and a track before the track is re-aligned. */
const MAX_DRIFT = 0.12

/**
 * Plays each audio track as its own element through a gain node, following the (muted) video, so
 * the mic and desktop audio can be balanced live. Until the tracks are ready the video's own audio plays.
 */
export function useTrackMixer(clip: ClipView, video: HTMLVideoElement | null, volumes: number[]): boolean {
  const [ready, setReady] = useState(false)
  const gains = useRef<GainNode[]>([])

  useEffect(() => {
    if (!video || clip.audioTracks.length === 0) return
    let disposed = false
    let dispose = (): void => {}
    void window.podium.library.audioTracks(clip.id).then((urls) => {
      if (disposed || urls.length === 0) return
      const context = new AudioContext()
      const elements = urls.map((url) => {
        const audio = new Audio()
        audio.crossOrigin = 'anonymous'
        audio.preload = 'auto'
        audio.src = url
        return audio
      })
      gains.current = elements.map((audio) => {
        const gain = context.createGain()
        context.createMediaElementSource(audio).connect(gain).connect(context.destination)
        return gain
      })
      const align = (force: boolean): void => {
        for (const audio of elements) {
          if (force || Math.abs(audio.currentTime - video.currentTime) > MAX_DRIFT)
            audio.currentTime = video.currentTime
        }
      }
      const play = (): void => {
        align(true)
        void context.resume()
        for (const audio of elements) {
          audio.playbackRate = video.playbackRate
          void audio.play().catch(() => {})
        }
      }
      const pause = (): void => elements.forEach((a) => a.pause())
      const onTime = (): void => {
        if (!video.paused) align(false)
      }
      const onSeek = (): void => align(true)
      const events: Array<[string, () => void]> = [
        ['playing', play],
        ['pause', pause],
        ['waiting', pause],
        ['seeked', onSeek],
        ['timeupdate', onTime],
        ['ratechange', () => elements.forEach((a) => (a.playbackRate = video.playbackRate))]
      ]
      for (const [name, handler] of events) video.addEventListener(name, handler)
      video.muted = true
      if (!video.paused) play()
      setReady(true)
      dispose = () => {
        for (const [name, handler] of events) video.removeEventListener(name, handler)
        pause()
        for (const audio of elements) audio.removeAttribute('src')
        void context.close()
        gains.current = []
        video.muted = false
        setReady(false)
      }
    })
    return () => {
      disposed = true
      dispose()
    }
  }, [clip.id, clip.size, clip.audioTracks.length, video])

  useEffect(() => {
    gains.current.forEach((gain, i) => (gain.gain.value = volumes[i] ?? 1))
  }, [volumes, ready])

  return ready
}
