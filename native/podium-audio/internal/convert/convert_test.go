package convert

import (
	"encoding/binary"
	"math"
	"testing"
)

func decodeOutput(b []byte) []float32 {
	out := make([]float32, len(b)/4)
	for i := range out {
		out[i] = math.Float32frombits(binary.LittleEndian.Uint32(b[i*4:]))
	}
	return out
}

func TestPassthrough(t *testing.T) {
	c, err := New(Format{Rate: 48000, Channels: 2, ContainerBits: 32, ValidBits: 32, Float: true})
	if err != nil {
		t.Fatal(err)
	}
	in := binary.LittleEndian.AppendUint32(nil, math.Float32bits(0.25))
	in = binary.LittleEndian.AppendUint32(in, math.Float32bits(-0.5))
	got := decodeOutput(c.Convert(nil, in, 1))
	if len(got) != 2 || got[0] != 0.25 || got[1] != -0.5 {
		t.Fatalf("passthrough changed samples: %v", got)
	}
}

func floatFrame(samples ...float32) []byte {
	var b []byte
	for _, s := range samples {
		b = binary.LittleEndian.AppendUint32(b, math.Float32bits(s))
	}
	return b
}

func near(a, b float32) bool {
	return math.Abs(float64(a-b)) < 1e-5
}

func TestDownmix(t *testing.T) {
	const c = minus3dB
	cases := []struct {
		name   string
		format Format
		in     []byte
		want   [2]float32
	}{
		{"5.1 from mask", Format{48000, 6, 32, 32, true, 0x3F}, floatFrame(0.1, 0.2, 0.4, 0.9, 0.3, 0),
			[2]float32{0.1 + c*0.4 + c*0.3, 0.2 + c*0.4}},
		{"5.1 side from mask", Format{48000, 6, 32, 32, true, 0x60F}, floatFrame(0.1, 0.2, 0.4, 0.9, 0, 0.3),
			[2]float32{0.1 + c*0.4, 0.2 + c*0.4 + c*0.3}},
		{"7.1 standard layout without mask", Format{48000, 8, 32, 32, true, 0}, floatFrame(0.1, 0.1, 0, 0.9, 0.1, 0.2, 0.1, 0.2),
			[2]float32{0.1 + c*0.1 + c*0.1, 0.1 + c*0.2 + c*0.2}},
		{"loud 5.1 clamps", Format{48000, 6, 32, 32, true, 0x3F}, floatFrame(0.9, -0.9, 0, 0, 0.9, -0.9),
			[2]float32{1, -1}},
		{"mismatched mask falls back to layout", Format{48000, 4, 32, 32, true, 0x3}, floatFrame(0.1, 0.2, 0.4, 0.4),
			[2]float32{0.1 + c*0.4, 0.2 + c*0.4}},
	}
	for _, tc := range cases {
		conv, err := New(tc.format)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		got := decodeOutput(conv.Convert(nil, tc.in, 1))
		if len(got) != 2 || !near(got[0], tc.want[0]) || !near(got[1], tc.want[1]) {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}

// toneLevel converts a 1 s sine at `freq` from `rate` to the output rate and returns the output RMS level in dB
// relative to the input's, skipping the filter's start-up.
func toneLevel(t *testing.T, rate int, freq float64) float64 {
	conv, err := New(Format{Rate: rate, Channels: 2, ContainerBits: 32, ValidBits: 32, Float: true})
	if err != nil {
		t.Fatal(err)
	}
	var out []byte
	for start := 0; start < rate; start += 480 {
		var in []byte
		for i := start; i < start+480; i++ {
			s := float32(0.5 * math.Sin(2*math.Pi*freq*float64(i)/float64(rate)))
			in = append(in, floatFrame(s, s)...)
		}
		out = conv.Convert(out, in, 480)
	}
	samples := decodeOutput(out)[4800:] // past the first 50 ms
	sum := 0.0
	for _, s := range samples {
		sum += float64(s) * float64(s)
	}
	rms := math.Sqrt(sum / float64(len(samples)))
	return 20 * math.Log10(rms/(0.5/math.Sqrt2))
}

func TestDownsamplingFiltersAboveNyquist(t *testing.T) {
	for _, tc := range []struct {
		rate int
		freq float64
	}{{96000, 30000}, {96000, 40000}, {192000, 30000}, {192000, 70000}, {88200, 26000}} {
		db := toneLevel(t, tc.rate, tc.freq)
		t.Logf("%d Hz tone at %d Hz: %.1f dB", int(tc.freq), tc.rate, db)
		if db > -50 {
			t.Errorf("%d Hz tone at %d Hz came through at %.1f dB, want below -50 dB", int(tc.freq), tc.rate, db)
		}
	}
	for _, rate := range []int{96000, 192000} {
		if db := toneLevel(t, rate, 1000); math.Abs(db) > 0.5 {
			t.Errorf("1 kHz tone at %d Hz came through at %.1f dB, want about 0 dB", rate, db)
		}
	}
}

func TestIntegerFormats(t *testing.T) {
	cases := []struct {
		name   string
		format Format
		in     []byte
		want   [2]float32
	}{
		{"int16 stereo", Format{48000, 2, 16, 16, false, 0}, []byte{0x00, 0x40, 0x00, 0xC0}, [2]float32{0.5, -0.5}},
		{"int16 mono", Format{48000, 1, 16, 16, false, 0}, []byte{0x00, 0x40}, [2]float32{0.5, 0.5}},
		{"int24 packed", Format{48000, 2, 24, 24, false, 0}, []byte{0x00, 0x00, 0x40, 0x00, 0x00, 0xC0}, [2]float32{0.5, -0.5}},
		{"int24 in 32", Format{48000, 2, 32, 24, false, 0}, []byte{0, 0, 0, 0x40, 0, 0, 0, 0xC0}, [2]float32{0.5, -0.5}},
		{"uint8", Format{48000, 2, 8, 8, false, 0}, []byte{192, 64}, [2]float32{0.5, -0.5}},
	}
	for _, tc := range cases {
		c, err := New(tc.format)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		got := decodeOutput(c.Convert(nil, tc.in, 1))
		if len(got) != 2 || got[0] != tc.want[0] || got[1] != tc.want[1] {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}

// Resampling 44.1 kHz in uneven packet sizes must produce exactly the expected number of frames and keep a sine wave
// continuous across packet boundaries.
func TestResampleLengthAndContinuity(t *testing.T) {
	c, err := New(Format{Rate: 44100, Channels: 1, ContainerBits: 32, ValidBits: 32, Float: true})
	if err != nil {
		t.Fatal(err)
	}
	const seconds = 3
	total := 44100 * seconds
	var out []byte
	for done := 0; done < total; {
		n := min(441+done%97, total-done)
		var in []byte
		for i := done; i < done+n; i++ {
			in = binary.LittleEndian.AppendUint32(in, math.Float32bits(float32(math.Sin(2*math.Pi*440*float64(i)/44100))))
		}
		out = c.Convert(out, in, n)
		done += n
	}
	samples := decodeOutput(out)
	frames := len(samples) / 2
	if frames < 48000*seconds-1 || frames > 48000*seconds {
		t.Fatalf("got %d frames, want about %d", frames, 48000*seconds)
	}
	for i := 0; i < frames; i++ {
		want := math.Sin(2 * math.Pi * 440 * float64(i) / 48000)
		if diff := math.Abs(float64(samples[i*2]) - want); diff > 0.01 {
			t.Fatalf("frame %d: got %f, want %f", i, samples[i*2], want)
		}
	}
}

func TestSilenceKeepsResampleTiming(t *testing.T) {
	c, err := New(Format{Rate: 44100, Channels: 2, ContainerBits: 16, ValidBits: 16, Float: false})
	if err != nil {
		t.Fatal(err)
	}
	out := c.Convert(nil, nil, 44100)
	if frames := len(out) / 8; frames < 47999 || frames > 48000 {
		t.Fatalf("silence produced %d frames, want about 48000", frames)
	}
	for _, s := range decodeOutput(out) {
		if s != 0 {
			t.Fatal("silence produced a non-zero sample")
		}
	}
}

func TestRejectsUnknownFormats(t *testing.T) {
	if _, err := New(Format{Rate: 48000, Channels: 2, ContainerBits: 20, ValidBits: 20}); err == nil {
		t.Fatal("expected 20-bit containers to be rejected")
	}
	if _, err := New(Format{Rate: 48000, Channels: 2, ContainerBits: 16, ValidBits: 16, Float: true}); err == nil {
		t.Fatal("expected 16-bit float to be rejected")
	}
}
