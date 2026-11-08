package convert

import "math"

const (
	// lowPassCutoff is the -6 dB point of the anti-alias filter: halfway between the top of the audible band (20 kHz)
	// and the output Nyquist frequency (24 kHz), so the transition band fits between them.
	lowPassCutoff = 22000
	// lowPassTransition is the width of that transition band, which sets the tap count.
	lowPassTransition = 4000
)

// lowPass is a Blackman-windowed sinc FIR filter applied to stereo frames before downsampling, so content above
// 24 kHz is removed instead of folding back into the audible band. Its stopband is about -74 dB.
type lowPass struct {
	taps []float32
	hist []float32 // The last len(taps)-1 stereo input frames, interleaved.
	work []float32 // Scratch: hist followed by the current packet.
}

func newLowPass(rate int) *lowPass {
	// A Blackman window needs about 5.5 / (transition / rate) taps; keep the count odd so the filter is symmetric
	// around a whole sample.
	n := int(math.Ceil(5.5*float64(rate)/lowPassTransition)) | 1
	fc := float64(lowPassCutoff) / float64(rate)
	taps := make([]float32, n)
	mid := float64(n-1) / 2
	sum := 0.0
	coeffs := make([]float64, n)
	for i := range coeffs {
		x := float64(i) - mid
		sinc := 2 * fc
		if x != 0 {
			sinc = math.Sin(2*math.Pi*fc*x) / (math.Pi * x)
		}
		window := 0.42 - 0.5*math.Cos(2*math.Pi*float64(i)/float64(n-1)) + 0.08*math.Cos(4*math.Pi*float64(i)/float64(n-1))
		coeffs[i] = sinc * window
		sum += coeffs[i]
	}
	for i, c := range coeffs {
		taps[i] = float32(c / sum) // Unity gain at DC
	}
	return &lowPass{taps: taps, hist: make([]float32, 2*(n-1))}
}

// apply filters interleaved stereo frames in place, continuing from the previous call.
func (f *lowPass) apply(frames []float32) {
	f.work = append(append(f.work[:0], f.hist...), frames...)
	for i := 0; i < len(frames)/2; i++ {
		var left, right float32
		window := f.work[i*2 : i*2+len(f.taps)*2]
		for k, t := range f.taps {
			left += t * window[k*2]
			right += t * window[k*2+1]
		}
		frames[i*2] = left
		frames[i*2+1] = right
	}
	copy(f.hist, f.work[len(f.work)-len(f.hist):])
}
