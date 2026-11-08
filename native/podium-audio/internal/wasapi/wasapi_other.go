//go:build !windows

package wasapi

import "errors"

var errUnsupported = errors.New("WASAPI loopback capture is only available on Windows")

// ListOutputs is only implemented on Windows.
func ListOutputs() ([]Device, error) {
	return nil, errUnsupported
}

// Capture is only implemented on Windows.
func Capture(opts CaptureOptions) error {
	return errUnsupported
}
