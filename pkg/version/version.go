package version

import (
	"github.com/fatedier/frp/pkg/util/version"
)

// These values are overridden at build time via -ldflags -X (see
// .goreleaser.yml and deploy/Dockerfile). Defaults are placeholders so
// `go run` works during development.
var (
	Number = "0.0.6"
	// FRPVersion is the version of FRP used by this program
	FRPVersion = version.Full()
	// BuildDate is the day that this program was built
	BuildDate = "unknown"
)
