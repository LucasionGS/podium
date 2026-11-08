package wasapi

import (
	"runtime"
	"syscall"
	"unsafe"
)

// IMMDeviceEnumerator, IMMDeviceCollection, IMMDevice and IPropertyStore vtable indices (after IUnknown's 0-2).
const (
	enumEnumAudioEndpoints       = 3
	enumGetDefaultAudioEndpoint  = 4
	enumGetDevice                = 5
	collectionGetCount           = 3
	collectionItem               = 4
	deviceActivate               = 3
	deviceOpenPropertyStore      = 4
	deviceGetID                  = 5
	deviceGetState               = 6
	propertyStoreGetValue        = 5
	audioClientInitialize        = 3
	audioClientGetBufferSize     = 4
	audioClientGetCurrentPadding = 6
	audioClientGetMixFormat      = 8
	audioClientStart             = 10
	audioClientStop              = 11
	audioClientGetService        = 14
	captureClientGetBuffer       = 3
	captureClientReleaseBuffer   = 4
	captureClientGetNextPacketSz = 5
	renderClientGetBuffer        = 3
	renderClientReleaseBuffer    = 4
)

type enumerator struct{ obj *comObject }

func newEnumerator() (*enumerator, error) {
	var obj *comObject
	r, _, _ := procCoCreateInstance.Call(
		uintptr(unsafe.Pointer(&clsidMMDeviceEnumerator)), 0, clsctxAll,
		uintptr(unsafe.Pointer(&iidIMMDeviceEnumerator)), uintptr(unsafe.Pointer(&obj)),
	)
	if err := check("CoCreateInstance(MMDeviceEnumerator)", uint32(r)); err != nil {
		return nil, err
	}
	return &enumerator{obj}, nil
}

func (e *enumerator) release() {
	if e != nil {
		e.obj.release()
	}
}

// defaultOutput returns the console default render endpoint, or errNoDefaultOutputDevice when there is none.
func (e *enumerator) defaultOutput() (*device, error) {
	var obj *comObject
	hr := e.obj.call(enumGetDefaultAudioEndpoint, eRender, eConsole, uintptr(unsafe.Pointer(&obj)))
	if hr == eNotFound {
		return nil, errNoDefaultOutputDevice
	}
	if err := check("GetDefaultAudioEndpoint", hr); err != nil {
		return nil, err
	}
	return &device{obj}, nil
}

// defaultOutputID returns the default output's id, or "" when there is none.
func (e *enumerator) defaultOutputID() (string, error) {
	dev, err := e.defaultOutput()
	if err == errNoDefaultOutputDevice {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	defer dev.release()
	return dev.id()
}

// device returns the endpoint with the given id, whatever its state. E_NOTFOUND means no such endpoint exists.
func (e *enumerator) device(id string) (*device, error) {
	wide, err := syscall.UTF16PtrFromString(id)
	if err != nil {
		return nil, &HResultError{"GetDevice", eInvalidArg}
	}
	var obj *comObject
	hr := e.obj.call(enumGetDevice, uintptr(unsafe.Pointer(wide)), uintptr(unsafe.Pointer(&obj)))
	runtime.KeepAlive(wide)
	if err := check("GetDevice", hr); err != nil {
		return nil, err
	}
	return &device{obj}, nil
}

// activeOutputs returns every active render endpoint.
func (e *enumerator) activeOutputs() ([]*device, error) {
	var coll *comObject
	hr := e.obj.call(enumEnumAudioEndpoints, eRender, deviceStateActive, uintptr(unsafe.Pointer(&coll)))
	if err := check("EnumAudioEndpoints", hr); err != nil {
		return nil, err
	}
	defer coll.release()
	var count uint32
	if err := check("IMMDeviceCollection::GetCount", coll.call(collectionGetCount, uintptr(unsafe.Pointer(&count)))); err != nil {
		return nil, err
	}
	devices := make([]*device, 0, count)
	for i := uint32(0); i < count; i++ {
		var obj *comObject
		if err := check("IMMDeviceCollection::Item", coll.call(collectionItem, uintptr(i), uintptr(unsafe.Pointer(&obj)))); err != nil {
			for _, d := range devices {
				d.release()
			}
			return nil, err
		}
		devices = append(devices, &device{obj})
	}
	return devices, nil
}

type device struct{ obj *comObject }

func (d *device) release() {
	if d != nil {
		d.obj.release()
	}
}

func (d *device) id() (string, error) {
	var p *uint16
	if err := check("IMMDevice::GetId", d.obj.call(deviceGetID, uintptr(unsafe.Pointer(&p)))); err != nil {
		return "", err
	}
	defer coTaskMemFree(unsafe.Pointer(p))
	return utf16PtrToString(p), nil
}

func (d *device) isActive() (bool, error) {
	var state uint32
	if err := check("IMMDevice::GetState", d.obj.call(deviceGetState, uintptr(unsafe.Pointer(&state)))); err != nil {
		return false, err
	}
	return state&deviceStateActive != 0, nil
}

// name returns the friendly name ("Speakers (Realtek(R) Audio)"), falling back to the description and then to "".
func (d *device) name() string {
	var store *comObject
	if failed(d.obj.call(deviceOpenPropertyStore, stgmRead, uintptr(unsafe.Pointer(&store)))) {
		return ""
	}
	defer store.release()
	for _, key := range []*propertyKey{&pkeyDeviceFriendlyName, &pkeyDeviceDescription} {
		if name := stringProperty(store, key); name != "" {
			return name
		}
	}
	return ""
}

func stringProperty(store *comObject, key *propertyKey) string {
	var value propVariant
	if failed(store.call(propertyStoreGetValue, uintptr(unsafe.Pointer(key)), uintptr(unsafe.Pointer(&value)))) {
		return ""
	}
	defer procPropVariantClear.Call(uintptr(unsafe.Pointer(&value)))
	if value.VT != vtLPWStr {
		return ""
	}
	return utf16PtrToString(value.Val)
}

// ListOutputs returns every active output device. It initialises COM on a locked OS thread of its own.
func ListOutputs() ([]Device, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := initCOM(); err != nil {
		return nil, err
	}
	defer uninitCOM()

	enum, err := newEnumerator()
	if err != nil {
		return nil, err
	}
	defer enum.release()
	defaultID, err := enum.defaultOutputID()
	if err != nil {
		return nil, err
	}
	devices, err := enum.activeOutputs()
	if err != nil {
		return nil, err
	}
	list := make([]Device, 0, len(devices))
	for _, dev := range devices {
		id, err := dev.id()
		if err == nil {
			list = append(list, Device{ID: id, Name: dev.name(), Default: id == defaultID})
		}
		dev.release()
	}
	return list, nil
}
