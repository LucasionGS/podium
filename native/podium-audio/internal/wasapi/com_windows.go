package wasapi

import (
	"fmt"
	"syscall"
	"unsafe"
)

var (
	ole32                = syscall.NewLazyDLL("ole32.dll")
	procCoInitializeEx   = ole32.NewProc("CoInitializeEx")
	procCoUninitialize   = ole32.NewProc("CoUninitialize")
	procCoCreateInstance = ole32.NewProc("CoCreateInstance")
	procCoTaskMemFree    = ole32.NewProc("CoTaskMemFree")
	procPropVariantClear = ole32.NewProc("PropVariantClear")
)

type guid struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

var (
	clsidMMDeviceEnumerator  = guid{0xBCDE0395, 0xE52F, 0x467C, [8]byte{0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E}}
	iidIMMDeviceEnumerator   = guid{0xA95664D2, 0x9614, 0x4F35, [8]byte{0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6}}
	iidIAudioClient          = guid{0x1CB9AD4C, 0xDBFA, 0x4C32, [8]byte{0xB1, 0x78, 0xC2, 0xF5, 0x68, 0xA7, 0x03, 0xB2}}
	iidIAudioRenderClient    = guid{0xF294ACFC, 0x3146, 0x4483, [8]byte{0xA7, 0xBF, 0xAD, 0xDC, 0xA7, 0xC2, 0x60, 0xE2}}
	iidIAudioCaptureClient   = guid{0xC8ADBD64, 0xE71E, 0x48A0, [8]byte{0xA4, 0xDE, 0x18, 0x5C, 0x39, 0x5C, 0xD3, 0x17}}
	subtypeIEEEFloat         = guid{0x00000003, 0x0000, 0x0010, [8]byte{0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71}}
	subtypePCM               = guid{0x00000001, 0x0000, 0x0010, [8]byte{0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71}}
	pkeyDeviceFriendlyName   = propertyKey{guid{0xA45C254E, 0xDF1C, 0x4EFD, [8]byte{0x80, 0x20, 0x67, 0xD1, 0x46, 0xA8, 0x50, 0xE0}}, 14}
	pkeyDeviceDescription    = propertyKey{guid{0xA45C254E, 0xDF1C, 0x4EFD, [8]byte{0x80, 0x20, 0x67, 0xD1, 0x46, 0xA8, 0x50, 0xE0}}, 2}
	errNoDefaultOutputDevice = fmt.Errorf("no output device is available")
)

type propertyKey struct {
	FmtID guid
	PID   uint32
}

// propVariant is the 64-bit PROPVARIANT layout: a type tag, three reserved words and a 16-byte value union.
type propVariant struct {
	VT        uint16
	reserved1 uint16
	reserved2 uint16
	reserved3 uint16
	Val       *uint16 // Only VT_LPWSTR values are read.
	val2      uintptr
}

const vtLPWStr = 31

// HRESULT values the capture loop reacts to or names in its logs.
const (
	sOK                                 = 0x00000000
	sFalse                              = 0x00000001
	audclntSBufferEmpty                 = 0x08890001
	audclntEDeviceInvalidated           = 0x88890004
	audclntEUnsupportedFormat           = 0x88890008
	audclntEDeviceInUse                 = 0x8889000A
	audclntEServiceNotRunning           = 0x88890010
	audclntEResourcesInvalidated        = 0x88890026
	audclntEEndpointCreateFailed        = 0x8889000F
	eNotFound                           = 0x80070490
	eInvalidArg                         = 0x80070057
	eOutOfMemory                        = 0x8007000E
	rpcEChangedMode                     = 0x80010106
	coinitMultithreaded                 = 0x0
	clsctxAll                           = 0x17
	stgmRead                            = 0x0
	eRender                             = 0
	eConsole                            = 0
	deviceStateActive                   = 0x1
	audclntShareModeShared              = 0
	audclntStreamFlagsLoopback          = 0x00020000
	audclntStreamFlagsAutoConvert       = 0x80000000
	audclntStreamFlagsSrcDefault        = 0x08000000
	audclntBufferFlagsSilent            = 0x2
	audclntBufferFlagsDataDiscontinuity = 0x1
)

// HResultError is a failed COM call.
type HResultError struct {
	Op string
	HR uint32
}

func (e *HResultError) Error() string {
	return fmt.Sprintf("%s: %s", e.Op, hresultName(e.HR))
}

func hresultName(hr uint32) string {
	switch hr {
	case audclntEDeviceInvalidated:
		return "AUDCLNT_E_DEVICE_INVALIDATED"
	case audclntEUnsupportedFormat:
		return "AUDCLNT_E_UNSUPPORTED_FORMAT"
	case audclntEDeviceInUse:
		return "AUDCLNT_E_DEVICE_IN_USE"
	case audclntEServiceNotRunning:
		return "AUDCLNT_E_SERVICE_NOT_RUNNING"
	case audclntEResourcesInvalidated:
		return "AUDCLNT_E_RESOURCES_INVALIDATED"
	case audclntEEndpointCreateFailed:
		return "AUDCLNT_E_ENDPOINT_CREATE_FAILED"
	case eNotFound:
		return "E_NOTFOUND"
	case eInvalidArg:
		return "E_INVALIDARG"
	case eOutOfMemory:
		return "E_OUTOFMEMORY"
	}
	return fmt.Sprintf("HRESULT 0x%08X", hr)
}

func failed(hr uint32) bool {
	return int32(hr) < 0
}

func check(op string, hr uint32) error {
	if failed(hr) {
		return &HResultError{op, hr}
	}
	return nil
}

// hresultOf returns the HRESULT of a failed COM call, or 0 when err is something else.
func hresultOf(err error) uint32 {
	if e, ok := err.(*HResultError); ok {
		return e.HR
	}
	return 0
}

// comObject is a pointer to a COM interface: its first word points at the vtable.
type comObject struct {
	vtbl *[64]uintptr
}

// call invokes vtable method `index` with the object as the implicit `this` argument and returns the HRESULT.
//
//go:uintptrescapes
func (o *comObject) call(index int, args ...uintptr) uint32 {
	full := make([]uintptr, 0, len(args)+1)
	full = append(full, uintptr(unsafe.Pointer(o)))
	full = append(full, args...)
	r, _, _ := syscall.SyscallN(o.vtbl[index], full...)
	return uint32(r)
}

func (o *comObject) release() {
	if o != nil {
		o.call(2)
	}
}

// initCOM joins the multi-threaded apartment. The caller must have locked its OS thread and must call uninitCOM on it.
func initCOM() error {
	r, _, _ := procCoInitializeEx.Call(0, coinitMultithreaded)
	hr := uint32(r)
	if hr == rpcEChangedMode {
		return fmt.Errorf("CoInitializeEx: thread already joined a single-threaded apartment")
	}
	return check("CoInitializeEx", hr)
}

func uninitCOM() {
	procCoUninitialize.Call()
}

func coTaskMemFree(p unsafe.Pointer) {
	if p != nil {
		procCoTaskMemFree.Call(uintptr(p))
	}
}

// utf16PtrToString copies a NUL-terminated UTF-16 string owned by the callee.
func utf16PtrToString(p *uint16) string {
	if p == nil {
		return ""
	}
	n := 0
	for *(*uint16)(unsafe.Add(unsafe.Pointer(p), n*2)) != 0 {
		n++
	}
	return syscall.UTF16ToString(unsafe.Slice(p, n))
}
