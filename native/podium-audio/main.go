// Command podium-audio lists Windows audio output devices and records one through WASAPI loopback, streaming raw
// interleaved stereo float32 little-endian PCM at 48 kHz to stdout for Podium's Windows capture engine.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"strings"
	"sync"

	"github.com/LucasionGS/podium/native/podium-audio/internal/wasapi"
)

const version = "0.1.0"

// Exit codes.
const (
	exitOK      = 0
	exitFailure = 1
	exitUsage   = 2
)

var logger = log.New(os.Stderr, "[podium-audio] ", 0)

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) == 0 {
		usage(os.Stderr)
		return exitUsage
	}
	switch args[0] {
	case "list", "ls":
		return list(args[1:])
	case "capture":
		return capture(args[1:])
	case "help", "-h", "--help":
		usage(os.Stdout)
		return exitOK
	case "version", "-v", "--version":
		fmt.Println(version)
		return exitOK
	}
	fmt.Fprintf(os.Stderr, "Command not found: %s\n", args[0])
	usage(os.Stderr)
	return exitUsage
}

func usage(w io.Writer) {
	fmt.Fprint(w, `podium-audio `+version+` - record a Windows audio output through WASAPI loopback

Usage:
  podium-audio list                       Print every active output device as one JSON object per line
  podium-audio capture [--device <ID>]    Stream 48 kHz stereo float32 PCM to stdout until stdin closes
  podium-audio help                       Show this help
  podium-audio version                    Print the version

Options:
  -d, --device <ID>   Endpoint id from "list". Without it, capture follows the default output device.
`)
}

func list(args []string) int {
	if len(args) > 0 {
		fmt.Fprintf(os.Stderr, "Unknown argument: %s\nUsage: podium-audio list\n", args[0])
		return exitUsage
	}
	devices, err := wasapi.ListOutputs()
	if err != nil {
		logger.Printf("cannot list output devices: %v", err)
		return exitFailure
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	for _, d := range devices {
		if err := enc.Encode(d); err != nil {
			return exitOK // stdout closed by the reader
		}
	}
	return exitOK
}

func capture(args []string) int {
	opts := wasapi.CaptureOptions{
		ForceMixFormat: os.Getenv("PODIUM_AUDIO_MIX_FORMAT") == "1",
		Logf:           logger.Printf,
	}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--device" || arg == "-d":
			if i+1 >= len(args) || args[i+1] == "" {
				fmt.Fprintf(os.Stderr, "Missing value for %s.\nUsage: podium-audio capture [--device <ID>]\n", arg)
				return exitUsage
			}
			i++
			opts.DeviceID = args[i]
		case strings.HasPrefix(arg, "--device="):
			opts.DeviceID = strings.TrimPrefix(arg, "--device=")
			if opts.DeviceID == "" {
				fmt.Fprintln(os.Stderr, "Missing value for --device.\nUsage: podium-audio capture [--device <ID>]")
				return exitUsage
			}
		default:
			fmt.Fprintf(os.Stderr, "Unknown argument: %s\nUsage: podium-audio capture [--device <ID>]\n", arg)
			return exitUsage
		}
	}

	// The parent stops capture by closing stdin, and stdin also reaches EOF when the parent dies.
	stop := make(chan struct{})
	var once sync.Once
	stopNow := func() { once.Do(func() { close(stop) }) }
	go func() {
		io.Copy(io.Discard, os.Stdin)
		stopNow()
	}()
	interrupts := make(chan os.Signal, 1)
	signal.Notify(interrupts, os.Interrupt)
	go func() {
		<-interrupts
		stopNow()
	}()

	opts.Stop = stop
	stdoutClosed := false
	opts.Write = func(pcm []byte) error {
		_, err := os.Stdout.Write(pcm)
		stdoutClosed = err != nil
		return err
	}

	err := wasapi.Capture(opts)
	select {
	case <-stop:
		logger.Printf("stdin closed, exiting")
		return exitOK
	default:
	}
	if err == nil {
		return exitOK
	}
	if stdoutClosed { // Nobody reads the PCM any more: the parent is gone
		logger.Printf("stdout closed, exiting")
		return exitOK
	}
	logger.Printf("capture failed: %v", err)
	return exitFailure
}
