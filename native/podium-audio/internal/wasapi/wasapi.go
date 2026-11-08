// Package wasapi lists Windows audio output devices and records them through WASAPI loopback as stereo float32 PCM
// at 48 kHz.
package wasapi

// Device is an active audio output (render) endpoint.
type Device struct {
	ID      string `json:"id"`      // IMMDevice::GetId string.
	Name    string `json:"name"`    // PKEY_Device_FriendlyName.
	Default bool   `json:"default"` // Is the console default output.
}

// CaptureOptions configures Capture.
type CaptureOptions struct {
	// DeviceID is the endpoint to record. Empty records the default output and follows it when it changes.
	DeviceID string
	// ForceMixFormat skips asking WASAPI to convert to 48 kHz stereo float and always converts from the device's mix
	// format in Go instead. Used to exercise the fallback path on machines where autoconvert works.
	ForceMixFormat bool
	// Write receives every chunk of converted PCM. When it returns an error, Capture stops and returns that error.
	Write func(pcm []byte) error
	// Logf receives human-readable status lines without a trailing newline.
	Logf func(format string, args ...any)
	// Stop makes Capture release the device and return nil once closed.
	Stop <-chan struct{}
}
