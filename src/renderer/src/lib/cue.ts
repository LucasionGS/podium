let context: AudioContext | null = null

/** The "clip saved" sound: two soft rising notes, synthesised so there's no asset to ship. */
export function playCue(volume: number): void {
  context ??= new AudioContext()
  const ctx = context
  void ctx.resume()
  const start = ctx.currentTime + 0.01
  const master = ctx.createGain()
  master.gain.value = Math.max(0, Math.min(1, volume)) * 0.5
  master.connect(ctx.destination)
  ;[
    [880, 0],
    [1318.5, 0.09]
  ].forEach(([frequency, offset]) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = frequency!
    const t = start + offset!
    gain.gain.setValueAtTime(0, t)
    gain.gain.linearRampToValueAtTime(1, t + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35)
    osc.connect(gain).connect(master)
    osc.start(t)
    osc.stop(t + 0.4)
  })
}
