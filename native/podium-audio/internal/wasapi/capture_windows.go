package wasapi

import (
	"errors"
	"fmt"
	"runtime"
	"time"
)

const (
	pollInterval         = 10 * time.Millisecond
	defaultCheckInterval = time.Second
	retryDelay           = 2 * time.Second
	// followRetryDelay is shorter because a lost default output is usually replaced by a new default right away.
	followRetryDelay = 500 * time.Millisecond
	// defaultPollAfterLoss is how often the default output is checked while waiting for it to replace a lost one.
	defaultPollAfterLoss = 100 * time.Millisecond
)

var errDefaultChanged = errors.New("default output changed")

// writeError marks a failure of CaptureOptions.Write, which ends Capture instead of triggering a retry.
type writeError struct{ err error }

func (e *writeError) Error() string { return e.err.Error() }
func (e *writeError) Unwrap() error { return e.err }

type capturer struct {
	opts    CaptureOptions
	enum    *enumerator
	problem string // Last logged retry reason, so an outage is logged once instead of every retry.
}

// Capture records the configured output device until opts.Stop is closed (returns nil) or opts.Write fails (returns
// that error). Missing, disabled and lost devices are retried forever. All COM work runs on one locked OS thread.
func Capture(opts CaptureOptions) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := initCOM(); err != nil {
		return err
	}
	defer uninitCOM()

	c := &capturer{opts: opts}
	defer func() { c.enum.release() }()
	return c.run()
}

func (c *capturer) follow() bool {
	return c.opts.DeviceID == ""
}

func (c *capturer) run() error {
	for {
		if c.stopped() {
			return nil
		}
		dev, id, err := c.target()
		if err != nil {
			c.retryLater(err.Error())
			if c.wait(retryDelay) {
				return nil
			}
			continue
		}
		name := dev.name()
		s, err := openStream(dev, c.opts.ForceMixFormat)
		if err != nil {
			dev.release()
			c.resetEnumerator()
			c.retryLater(fmt.Sprintf("cannot open %q: %v, retrying", name, err))
			if c.wait(c.lossDelay()) {
				return nil
			}
			continue
		}

		c.problem = ""
		c.opts.Logf("recording %q (%s)", name, id)
		if s.autoconvert {
			c.opts.Logf("format: autoconvert")
		} else {
			c.opts.Logf("format: converting from %s", s.conv.Format())
		}
		if s.keepAliveErr != nil {
			c.opts.Logf("cannot play silence to keep loopback running (%v); quiet spells will be gaps", s.keepAliveErr)
		}
		err = c.pump(s, id)
		s.close()
		dev.release()

		var we *writeError
		switch {
		case err == nil:
			return nil
		case errors.Is(err, errDefaultChanged):
			c.opts.Logf("default output changed")
		case errors.As(err, &we):
			return we.err
		default:
			c.resetEnumerator()
			c.retryLater(fmt.Sprintf("device lost: %v, retrying", err))
			if c.follow() {
				if c.waitForNewDefault(id) {
					return nil
				}
			} else if c.wait(retryDelay) {
				return nil
			}
		}
	}
}

// target resolves the endpoint to record: the current default output, or the configured device if it is active.
func (c *capturer) target() (*device, string, error) {
	if c.enum == nil {
		enum, err := newEnumerator()
		if err != nil {
			return nil, "", fmt.Errorf("audio service unavailable: %v, retrying", err)
		}
		c.enum = enum
	}

	if c.follow() {
		dev, err := c.enum.defaultOutput()
		if err == errNoDefaultOutputDevice {
			return nil, "", fmt.Errorf("no output device, retrying")
		}
		if err != nil {
			c.resetEnumerator()
			return nil, "", fmt.Errorf("cannot get default output: %v, retrying", err)
		}
		id, err := dev.id()
		if err != nil {
			dev.release()
			return nil, "", fmt.Errorf("cannot get default output: %v, retrying", err)
		}
		return dev, id, nil
	}

	id := c.opts.DeviceID
	dev, err := c.enum.device(id)
	if hresultOf(err) == eNotFound {
		return nil, "", fmt.Errorf("device not found: %s, retrying", id)
	}
	if err != nil {
		c.resetEnumerator()
		return nil, "", fmt.Errorf("device not found: %s (%v), retrying", id, err)
	}
	active, err := dev.isActive()
	if err != nil || !active {
		dev.release()
		return nil, "", fmt.Errorf("device not found: %s (not active), retrying", id)
	}
	return dev, id, nil
}

// pump polls the stream until it fails, writing fails, the default output moves away from id, or Stop closes.
func (c *capturer) pump(s *stream, id string) error {
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	lastCheck := time.Now()
	write := func(pcm []byte) error {
		if err := c.opts.Write(pcm); err != nil {
			return &writeError{err}
		}
		return nil
	}
	for {
		select {
		case <-c.opts.Stop:
			return nil
		case <-ticker.C:
		}
		if err := s.drain(write); err != nil {
			return err
		}
		if n := s.takeDiscontinuities(); n > 0 {
			c.opts.Logf("data discontinuity: %d packet(s) arrived after a gap", n)
		}
		if c.follow() && time.Since(lastCheck) >= defaultCheckInterval {
			lastCheck = time.Now()
			current, err := c.enum.defaultOutputID()
			if err == nil && current != id {
				return errDefaultChanged
			}
		}
	}
}

// waitForNewDefault waits up to followRetryDelay for the default output to move away from the lost endpoint, so the
// new default is recorded as soon as Windows has picked it. It reports whether Stop closed meanwhile.
func (c *capturer) waitForNewDefault(lost string) bool {
	for waited := time.Duration(0); waited < followRetryDelay; waited += defaultPollAfterLoss {
		if c.wait(defaultPollAfterLoss) {
			return true
		}
		if c.enum == nil {
			enum, err := newEnumerator()
			if err != nil {
				continue
			}
			c.enum = enum
		}
		if current, err := c.enum.defaultOutputID(); err == nil && current != "" && current != lost {
			return false
		}
	}
	return false
}

func (c *capturer) lossDelay() time.Duration {
	if c.follow() {
		return followRetryDelay
	}
	return retryDelay
}

// resetEnumerator drops the device enumerator so the next attempt creates a fresh one, which recovers from an audio
// service restart.
func (c *capturer) resetEnumerator() {
	c.enum.release()
	c.enum = nil
}

func (c *capturer) retryLater(reason string) {
	if reason != c.problem {
		c.problem = reason
		c.opts.Logf("%s", reason)
	}
}

func (c *capturer) stopped() bool {
	select {
	case <-c.opts.Stop:
		return true
	default:
		return false
	}
}

// wait sleeps for d and reports whether Stop closed meanwhile.
func (c *capturer) wait(d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-c.opts.Stop:
		return true
	case <-timer.C:
		return false
	}
}
