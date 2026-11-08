package wasapi

import (
	"encoding/binary"
	"fmt"
	"time"
	"unsafe"

	"github.com/LucasionGS/podium/native/podium-audio/internal/convert"
)

// bufferDuration is the WASAPI buffer length in 100 ns units. 200 ms leaves plenty of slack for a 10 ms poll timer.
const bufferDuration = 200 * 10000

const (
	waveFormatPCM        = 0x0001
	waveFormatIEEEFloat  = 0x0003
	waveFormatExtensible = 0xFFFE
)

// discontinuityLogInterval rate-limits the log line for AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.
const discontinuityLogInterval = 5 * time.Second

// stream is an initialised, started loopback capture on one endpoint.
type stream struct {
	dev         *device // Owned by the caller, which keeps it alive for the stream's lifetime.
	client      *comObject
	capture     *comObject
	conv        *convert.Converter
	autoconvert bool // WASAPI converts to the output format itself.
	buf         []byte

	// keepAlive plays silence on the same endpoint so loopback delivers packets even when nothing else plays. Nil
	// when it could not be opened (keepAliveErr says why); capture then still works, just with gaps.
	keepAlive    *silencePlayer
	keepAliveErr error

	packets        int64 // Packets read so far; the first one is flagged as a discontinuity by design.
	discontinuity  int   // Discontinuities since the last log line.
	discontinuityT time.Time
}

// requestedFormat is WAVEFORMATEXTENSIBLE for 48 kHz stereo IEEE float.
func requestedFormat() []byte {
	b := make([]byte, 0, 40)
	b = binary.LittleEndian.AppendUint16(b, waveFormatExtensible)
	b = binary.LittleEndian.AppendUint16(b, convert.OutputChannels)
	b = binary.LittleEndian.AppendUint32(b, convert.OutputRate)
	b = binary.LittleEndian.AppendUint32(b, convert.OutputRate*convert.OutputChannels*4)
	b = binary.LittleEndian.AppendUint16(b, convert.OutputChannels*4)
	b = binary.LittleEndian.AppendUint16(b, 32)
	b = binary.LittleEndian.AppendUint16(b, 22) // cbSize: the extensible fields below
	b = binary.LittleEndian.AppendUint16(b, 32) // wValidBitsPerSample
	b = binary.LittleEndian.AppendUint32(b, convert.SpeakerFrontLeft|convert.SpeakerFrontRight)
	return appendGUID(b, subtypeIEEEFloat)
}

func appendGUID(b []byte, g guid) []byte {
	b = binary.LittleEndian.AppendUint32(b, g.Data1)
	b = binary.LittleEndian.AppendUint16(b, g.Data2)
	b = binary.LittleEndian.AppendUint16(b, g.Data3)
	return append(b, g.Data4[:]...)
}

func readGUID(b []byte) guid {
	g := guid{binary.LittleEndian.Uint32(b), binary.LittleEndian.Uint16(b[4:]), binary.LittleEndian.Uint16(b[6:]), [8]byte{}}
	copy(g.Data4[:], b[8:16])
	return g
}

// parseWaveFormat reads a WAVEFORMATEX or WAVEFORMATEXTENSIBLE returned by GetMixFormat.
func parseWaveFormat(p unsafe.Pointer) (convert.Format, error) {
	head := unsafe.Slice((*byte)(p), 18)
	tag := binary.LittleEndian.Uint16(head)
	format := convert.Format{
		Channels:      int(binary.LittleEndian.Uint16(head[2:])),
		Rate:          int(binary.LittleEndian.Uint32(head[4:])),
		ContainerBits: int(binary.LittleEndian.Uint16(head[14:])),
	}
	format.ValidBits = format.ContainerBits
	switch tag {
	case waveFormatPCM:
	case waveFormatIEEEFloat:
		format.Float = true
	case waveFormatExtensible:
		if binary.LittleEndian.Uint16(head[16:]) < 22 {
			return format, fmt.Errorf("mix format is WAVE_FORMAT_EXTENSIBLE without its extension")
		}
		ext := unsafe.Slice((*byte)(p), 40)
		if valid := int(binary.LittleEndian.Uint16(ext[18:])); valid != 0 {
			format.ValidBits = valid
		}
		format.ChannelMask = binary.LittleEndian.Uint32(ext[20:])
		switch readGUID(ext[24:]) {
		case subtypeIEEEFloat:
			format.Float = true
		case subtypePCM:
		default:
			return format, fmt.Errorf("mix format has an unknown subtype")
		}
	default:
		return format, fmt.Errorf("mix format has unknown format tag 0x%04X", tag)
	}
	return format, format.Validate()
}

// openStream activates an audio client on dev and starts loopback capture, preferring WASAPI's own conversion to the
// output format and falling back to the device mix format converted in Go.
func openStream(dev *device, forceMixFormat bool) (*stream, error) {
	s := &stream{dev: dev}
	// The silence stream starts first so the loopback stream has a running engine to tap from its first packet.
	s.keepAlive, s.keepAliveErr = startSilencePlayer(dev)
	if err := s.activate(); err != nil {
		s.close()
		return nil, err
	}
	if err := s.initialize(forceMixFormat); err != nil {
		s.close()
		return nil, err
	}
	hr := s.client.call(audioClientGetService, uintptr(unsafe.Pointer(&iidIAudioCaptureClient)), uintptr(unsafe.Pointer(&s.capture)))
	if err := check("IAudioClient::GetService", hr); err != nil {
		s.close()
		return nil, err
	}
	if err := check("IAudioClient::Start", s.client.call(audioClientStart)); err != nil {
		s.close()
		return nil, err
	}
	return s, nil
}

func (s *stream) initialize(forceMixFormat bool) error {
	if !forceMixFormat {
		want := requestedFormat()
		flags := uintptr(audclntStreamFlagsLoopback | audclntStreamFlagsAutoConvert | audclntStreamFlagsSrcDefault)
		hr := s.client.call(audioClientInitialize, audclntShareModeShared, flags, bufferDuration, 0, uintptr(unsafe.Pointer(&want[0])), 0)
		if !failed(hr) {
			s.autoconvert = true
			conv, err := convert.New(convert.Format{Rate: convert.OutputRate, Channels: convert.OutputChannels, ContainerBits: 32, ValidBits: 32, Float: true})
			s.conv = conv
			return err
		}
		if hr == audclntEDeviceInvalidated || hr == audclntEServiceNotRunning {
			return &HResultError{"IAudioClient::Initialize", hr}
		}
		// An audio client can only be initialised once, even after a failed attempt, so the fallback needs a fresh one.
		s.client.release()
		s.client = nil
		if err := s.activate(); err != nil {
			return err
		}
	}

	var mix unsafe.Pointer
	if err := check("IAudioClient::GetMixFormat", s.client.call(audioClientGetMixFormat, uintptr(unsafe.Pointer(&mix)))); err != nil {
		return err
	}
	defer coTaskMemFree(mix)
	format, err := parseWaveFormat(mix)
	if err != nil {
		return err
	}
	hr := s.client.call(audioClientInitialize, audclntShareModeShared, audclntStreamFlagsLoopback, bufferDuration, 0, uintptr(mix), 0)
	if err := check("IAudioClient::Initialize(mix format)", hr); err != nil {
		return err
	}
	s.conv, err = convert.New(format)
	return err
}

// activate creates the stream's audio client on its device.
func (s *stream) activate() error {
	hr := s.dev.obj.call(deviceActivate, uintptr(unsafe.Pointer(&iidIAudioClient)), clsctxAll, 0, uintptr(unsafe.Pointer(&s.client)))
	return check("IMMDevice::Activate", hr)
}

func (s *stream) close() {
	if s.client != nil {
		s.client.call(audioClientStop)
	}
	s.capture.release()
	s.client.release()
	s.capture, s.client = nil, nil
	s.keepAlive.close()
	s.keepAlive = nil
}

// takeDiscontinuities returns how many discontinuities to report now, at most once per discontinuityLogInterval.
func (s *stream) takeDiscontinuities() int {
	if s.discontinuity == 0 || time.Since(s.discontinuityT) < discontinuityLogInterval {
		return 0
	}
	n := s.discontinuity
	s.discontinuity = 0
	s.discontinuityT = time.Now()
	return n
}

// drain reads every pending packet, converts it and passes it to write. It returns a HResultError when the device
// fails and write's error when writing fails.
func (s *stream) drain(write func([]byte) error) error {
	if err := s.keepAlive.feed(); err != nil {
		return err
	}
	for {
		var size uint32
		if err := check("IAudioCaptureClient::GetNextPacketSize", s.capture.call(captureClientGetNextPacketSz, uintptr(unsafe.Pointer(&size)))); err != nil {
			return err
		}
		if size == 0 {
			return nil
		}
		var data *byte
		var frames, flags uint32
		hr := s.capture.call(captureClientGetBuffer, uintptr(unsafe.Pointer(&data)), uintptr(unsafe.Pointer(&frames)), uintptr(unsafe.Pointer(&flags)), 0, 0)
		if hr == audclntSBufferEmpty {
			return nil
		}
		if err := check("IAudioCaptureClient::GetBuffer", hr); err != nil {
			return err
		}
		if flags&audclntBufferFlagsDataDiscontinuity != 0 && s.packets > 0 {
			s.discontinuity++
		}
		s.packets++
		var in []byte
		if flags&audclntBufferFlagsSilent == 0 && frames > 0 {
			in = unsafe.Slice(data, int(frames)*s.conv.Format().BlockAlign())
		}
		s.buf = s.conv.Convert(s.buf[:0], in, int(frames))
		if err := check("IAudioCaptureClient::ReleaseBuffer", s.capture.call(captureClientReleaseBuffer, uintptr(frames))); err != nil {
			return err
		}
		if len(s.buf) > 0 {
			if err := write(s.buf); err != nil {
				return err
			}
		}
	}
}
