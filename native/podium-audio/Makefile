BINARY := podium-audio.exe
OUT := ../../resources/win/$(BINARY)

.PHONY: build run test vet lint clean

# Cross-compiles the Windows helper; there is no Linux build.
build:
	GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o $(OUT) .

# Lists the output devices; only works on Windows.
run:
	go run . list

test:
	go test ./...

vet:
	GOOS=windows GOARCH=amd64 go vet ./...
	go vet ./...

lint: vet
	@test -z "$$(gofmt -l .)" || (gofmt -l . && exit 1)

clean:
	rm -f $(OUT)
