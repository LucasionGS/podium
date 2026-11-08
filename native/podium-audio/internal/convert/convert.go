// Package convert turns PCM in any common WASAPI mix format into interleaved stereo float32 little-endian at a fixed
// output rate.
package convert

import (
	"encoding/binary"
	"fmt"
	"math"
	"math/bits"
)

// OutputRate is the sample rate of everything Converter produces.
const OutputRate = 48000

// OutputChannels is the channel count of everything Converter produces.
const OutputChannels = 2

// Speaker position bits of WAVEFORMATEXTENSIBLE.dwChannelMask, in channel order.
const (
	SpeakerFrontLeft          = 0x1
	SpeakerFrontRight         = 0x2
	SpeakerFrontCenter        = 0x4
	SpeakerLowFrequency       = 0x8
	SpeakerBackLeft           = 0x10
	SpeakerBackRight          = 0x20
	SpeakerFrontLeftOfCenter  = 0x40
	SpeakerFrontRightOfCenter = 0x80
	SpeakerBackCenter         = 0x100
	SpeakerSideLeft           = 0x200
	SpeakerSideRight          = 0x400
	SpeakerTopCenter          = 0x800
	SpeakerTopFrontLeft       = 0x1000
	SpeakerTopFrontCenter     = 0x2000
	SpeakerTopFrontRight      = 0x4000
	SpeakerTopBackLeft        = 0x8000
	SpeakerTopBackCenter      = 0x10000
	SpeakerTopBackRight       = 0x20000
)

// minus3dB is the usual downmix gain for a centre or surround channel folded into one side.
const minus3dB = 0.7071068

// speakerGains maps a speaker position to its share of the left and right output. LFE is dropped.
var speakerGains = map[uint32][2]float32{
	SpeakerFrontLeft:          {1, 0},
	SpeakerFrontRight:         {0, 1},
	SpeakerFrontCenter:        {minus3dB, minus3dB},
	SpeakerLowFrequency:       {0, 0},
	SpeakerBackLeft:           {minus3dB, 0},
	SpeakerBackRight:          {0, minus3dB},
	SpeakerFrontLeftOfCenter:  {1, 0},
	SpeakerFrontRightOfCenter: {0, 1},
	SpeakerBackCenter:         {0.5, 0.5},
	SpeakerSideLeft:           {minus3dB, 0},
	SpeakerSideRight:          {0, minus3dB},
	SpeakerTopCenter:          {0.5, 0.5},
	SpeakerTopFrontLeft:       {minus3dB, 0},
	SpeakerTopFrontCenter:     {0.5, 0.5},
	SpeakerTopFrontRight:      {0, minus3dB},
	SpeakerTopBackLeft:        {minus3dB, 0},
	SpeakerTopBackCenter:      {0.5, 0.5},
	SpeakerTopBackRight:       {0, minus3dB},
}

// defaultMasks are Windows' standard layouts (KSAUDIO_SPEAKER_*) for formats that carry no usable channel mask.
var defaultMasks = map[int]uint32{
	2: SpeakerFrontLeft | SpeakerFrontRight,
	3: SpeakerFrontLeft | SpeakerFrontRight | SpeakerFrontCenter,
	4: SpeakerFrontLeft | SpeakerFrontRight | SpeakerBackLeft | SpeakerBackRight,
	5: SpeakerFrontLeft | SpeakerFrontRight | SpeakerFrontCenter | SpeakerBackLeft | SpeakerBackRight,
	6: SpeakerFrontLeft | SpeakerFrontRight | SpeakerFrontCenter | SpeakerLowFrequency | SpeakerBackLeft | SpeakerBackRight,
	8: SpeakerFrontLeft | SpeakerFrontRight | SpeakerFrontCenter | SpeakerLowFrequency | SpeakerBackLeft | SpeakerBackRight |
		SpeakerSideLeft | SpeakerSideRight,
}

// Format describes interleaved input PCM.
type Format struct {
	Rate          int    // Frames per second.
	Channels      int    // Interleaved channels per frame.
	ContainerBits int    // Bits each sample occupies in memory (8, 16, 24, 32 or 64).
	ValidBits     int    // Significant bits inside the container; equals ContainerBits for packed formats.
	Float         bool   // IEEE float samples (32 or 64 bit) instead of signed integers (unsigned for 8 bit).
	ChannelMask   uint32 // Speaker positions of the channels; 0 = the standard layout for the channel count.
}

// BlockAlign is the size of one input frame in bytes.
func (f Format) BlockAlign() int {
	return f.Channels * f.ContainerBits / 8
}

// IsOutput reports whether the format already is the output format, so no conversion work is needed.
func (f Format) IsOutput() bool {
	return f.Float && f.ContainerBits == 32 && f.Channels == OutputChannels && f.Rate == OutputRate
}

func (f Format) String() string {
	bits := f.ValidBits
	if bits == 0 {
		bits = f.ContainerBits
	}
	return fmt.Sprintf("%d Hz %d-bit %dch", f.Rate, bits, f.Channels)
}

// Validate returns an error when the format is not one Converter can decode.
func (f Format) Validate() error {
	if f.Rate <= 0 || f.Channels <= 0 {
		return fmt.Errorf("unsupported format %s: rate and channel count must be positive", f)
	}
	if f.Float {
		if f.ContainerBits != 32 && f.ContainerBits != 64 {
			return fmt.Errorf("unsupported format %s: float samples must be 32 or 64 bit", f)
		}
		return nil
	}
	switch f.ContainerBits {
	case 8, 16, 24, 32:
		return nil
	}
	return fmt.Errorf("unsupported format %s: integer samples must be 8, 16, 24 or 32 bit", f)
}

// Converter converts a stream of input packets. It keeps filter and resampling state between packets, so feed one
// stream through one Converter and create a new one whenever the stream is reopened.
type Converter struct {
	format Format
	block  int
	gains  [][2]float32 // Per input channel: share of the left and right output. Nil for plain mono or stereo.
	filter *lowPass     // Anti-alias filter, only when downsampling.

	// Resampler state. pos is the next output frame's position in source frames, scaled by OutputRate so the
	// arithmetic stays exact over hours of audio; a position of -OutputRate refers to prevL/prevR.
	pos          int64
	prevL, prevR float32

	frames []float32 // Scratch: decoded stereo frames of the current packet.
}

// New returns a Converter for the given input format.
func New(format Format) (*Converter, error) {
	if err := format.Validate(); err != nil {
		return nil, err
	}
	c := &Converter{format: format, block: format.BlockAlign()}
	if format.Channels > 2 {
		c.gains = downmixGains(format.Channels, format.ChannelMask)
	}
	if format.Rate > OutputRate {
		c.filter = newLowPass(format.Rate)
	}
	return c, nil
}

// downmixGains assigns every channel its stereo gains from the channel mask, falling back to the standard layout for
// the channel count when the mask doesn't describe exactly that many channels. Channels without a known position are
// dropped, except that the first two always count as front left and right when nothing better is known.
func downmixGains(channels int, mask uint32) [][2]float32 {
	if bits.OnesCount32(mask) != channels {
		mask = defaultMasks[channels]
	}
	gains := make([][2]float32, channels)
	if mask == 0 {
		gains[0] = [2]float32{1, 0}
		gains[1] = [2]float32{0, 1}
		return gains
	}
	for ch := 0; ch < channels; ch++ {
		speaker := mask & -mask // Lowest remaining bit: channels follow the mask's bit order.
		mask &^= speaker
		gains[ch] = speakerGains[speaker]
	}
	return gains
}

// Format returns the input format.
func (c *Converter) Format() Format {
	return c.format
}

// Convert appends the converted form of `frames` input frames read from `in` to `out` and returns it. A nil `in`
// stands for that many frames of silence.
func (c *Converter) Convert(out []byte, in []byte, frames int) []byte {
	if frames <= 0 {
		return out
	}
	if in == nil {
		if c.format.Rate == OutputRate {
			return append(out, make([]byte, frames*OutputChannels*4)...)
		}
		c.ensureFrames(frames)
		clear(c.frames)
	} else if c.format.IsOutput() {
		return append(out, in[:frames*c.block]...)
	} else {
		c.decode(in, frames)
	}
	if c.filter != nil {
		c.filter.apply(c.frames)
	}
	if c.format.Rate == OutputRate {
		return appendFrames(out, c.frames)
	}
	return c.resample(out, frames)
}

func (c *Converter) ensureFrames(frames int) {
	if cap(c.frames) < frames*2 {
		c.frames = make([]float32, frames*2)
	}
	c.frames = c.frames[:frames*2]
}

// decode fills c.frames with stereo float frames. Mono is duplicated to both sides; more than two channels are mixed
// down by their speaker positions and clamped, so loud surround content can't push the sum past full scale.
func (c *Converter) decode(in []byte, frames int) {
	c.ensureFrames(frames)
	step := c.format.ContainerBits / 8
	for i := 0; i < frames; i++ {
		base := i * c.block
		if c.gains != nil {
			var left, right float32
			for ch, g := range c.gains {
				if g[0] == 0 && g[1] == 0 {
					continue
				}
				s := c.sample(in[base+ch*step:])
				left += s * g[0]
				right += s * g[1]
			}
			c.frames[i*2] = clamp(left)
			c.frames[i*2+1] = clamp(right)
			continue
		}
		left := c.sample(in[base:])
		right := left
		if c.format.Channels > 1 {
			right = c.sample(in[base+step:])
		}
		c.frames[i*2] = left
		c.frames[i*2+1] = right
	}
}

func clamp(s float32) float32 {
	return max(-1, min(1, s))
}

// sample decodes the sample at the start of b to [-1, 1).
func (c *Converter) sample(b []byte) float32 {
	if c.format.Float {
		if c.format.ContainerBits == 64 {
			return float32(math.Float64frombits(binary.LittleEndian.Uint64(b)))
		}
		return math.Float32frombits(binary.LittleEndian.Uint32(b))
	}
	switch c.format.ContainerBits {
	case 8: // Unsigned, centred on 128
		return (float32(b[0]) - 128) / 128
	case 16:
		return float32(int16(binary.LittleEndian.Uint16(b))) / 32768
	case 24: // Packed, sign-extended through the top byte
		v := int32(uint32(b[0])<<8|uint32(b[1])<<16|uint32(b[2])<<24) >> 8
		return float32(v) / 8388608
	default: // 32-bit container; 24 valid bits are left-justified, so the same scale applies
		return float32(int32(binary.LittleEndian.Uint32(b))) / 2147483648
	}
}

// resample linearly interpolates c.frames (plus the last frame of the previous packet) to OutputRate.
func (c *Converter) resample(out []byte, frames int) []byte {
	src := int64(c.format.Rate)
	const dst = int64(OutputRate)
	last := int64(frames - 1)
	at := func(i int64) (float32, float32) {
		if i < 0 {
			return c.prevL, c.prevR
		}
		return c.frames[i*2], c.frames[i*2+1]
	}
	for c.pos < last*dst {
		i := floorDiv(c.pos, dst)
		frac := float32(c.pos-i*dst) / float32(dst)
		l0, r0 := at(i)
		l1, r1 := at(i + 1)
		out = appendFloat(out, l0+(l1-l0)*frac)
		out = appendFloat(out, r0+(r1-r0)*frac)
		c.pos += src
	}
	c.pos -= int64(frames) * dst
	c.prevL, c.prevR = c.frames[last*2], c.frames[last*2+1]
	return out
}

func floorDiv(a, b int64) int64 {
	q := a / b
	if a%b != 0 && a < 0 {
		q--
	}
	return q
}

func appendFrames(out []byte, samples []float32) []byte {
	for _, s := range samples {
		out = appendFloat(out, s)
	}
	return out
}

func appendFloat(out []byte, s float32) []byte {
	return binary.LittleEndian.AppendUint32(out, math.Float32bits(s))
}
