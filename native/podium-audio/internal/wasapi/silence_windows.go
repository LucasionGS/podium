package wasapi

import "unsafe"

// silencePlayer is a shared-mode render stream that plays nothing but silence. WASAPI loopback only delivers packets
// while some stream is rendering to the endpoint, so without it every quiet spell would be a gap in the PCM instead of
// silence, and the parent's wall-clock pacing would pull later audio early. OBS's win-wasapi does the same.
type silencePlayer struct {
	client *comObject
	render *comObject
	frames uint32 // Buffer size in frames.
}

// startSilencePlayer opens and starts a silent render stream on dev in the device mix format.
func startSilencePlayer(dev *device) (*silencePlayer, error) {
	p := &silencePlayer{}
	hr := dev.obj.call(deviceActivate, uintptr(unsafe.Pointer(&iidIAudioClient)), clsctxAll, 0, uintptr(unsafe.Pointer(&p.client)))
	if err := check("IMMDevice::Activate(render)", hr); err != nil {
		return nil, err
	}
	if err := p.init(); err != nil {
		p.close()
		return nil, err
	}
	return p, nil
}

func (p *silencePlayer) init() error {
	var mix unsafe.Pointer
	if err := check("IAudioClient::GetMixFormat(render)", p.client.call(audioClientGetMixFormat, uintptr(unsafe.Pointer(&mix)))); err != nil {
		return err
	}
	defer coTaskMemFree(mix)
	hr := p.client.call(audioClientInitialize, audclntShareModeShared, 0, bufferDuration, 0, uintptr(mix), 0)
	if err := check("IAudioClient::Initialize(render)", hr); err != nil {
		return err
	}
	if err := check("IAudioClient::GetBufferSize(render)", p.client.call(audioClientGetBufferSize, uintptr(unsafe.Pointer(&p.frames)))); err != nil {
		return err
	}
	hr = p.client.call(audioClientGetService, uintptr(unsafe.Pointer(&iidIAudioRenderClient)), uintptr(unsafe.Pointer(&p.render)))
	if err := check("IAudioClient::GetService(render)", hr); err != nil {
		return err
	}
	if err := p.feed(); err != nil {
		return err
	}
	return check("IAudioClient::Start(render)", p.client.call(audioClientStart))
}

// feed tops the render buffer up with silence. The silent flag makes WASAPI treat the frames as zeros, so the buffer
// contents never need writing.
func (p *silencePlayer) feed() error {
	if p == nil {
		return nil
	}
	var padding uint32
	if err := check("IAudioClient::GetCurrentPadding(render)", p.client.call(audioClientGetCurrentPadding, uintptr(unsafe.Pointer(&padding)))); err != nil {
		return err
	}
	free := p.frames - padding
	if free == 0 {
		return nil
	}
	var data *byte
	if err := check("IAudioRenderClient::GetBuffer", p.render.call(renderClientGetBuffer, uintptr(free), uintptr(unsafe.Pointer(&data)))); err != nil {
		return err
	}
	return check("IAudioRenderClient::ReleaseBuffer", p.render.call(renderClientReleaseBuffer, uintptr(free), audclntBufferFlagsSilent))
}

func (p *silencePlayer) close() {
	if p == nil {
		return
	}
	if p.client != nil {
		p.client.call(audioClientStop)
	}
	p.render.release()
	p.client.release()
	p.render, p.client = nil, nil
}
