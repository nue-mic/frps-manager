package config

import (
	"strings"
	"testing"
)

func TestParseServerTOML_MinimalBindPort(t *testing.T) {
	in := []byte("bindPort = 7000\n")
	sc, err := ParseServerTOML(in)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if sc.BindPort != 7000 {
		t.Fatalf("BindPort = %d, want 7000", sc.BindPort)
	}
}

func TestServerTOML_RoundTrip(t *testing.T) {
	in := []byte("bindPort = 7000\nvhostHTTPPort = 8080\n")
	sc, err := ParseServerTOML(in)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	out, err := sc.MarshalTOML()
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(out), "7000") || !strings.Contains(string(out), "8080") {
		t.Fatalf("round-trip lost fields:\n%s", out)
	}
	// 再解析一遍确认产物合法
	if _, err := ParseServerTOML(out); err != nil {
		t.Fatalf("re-parse: %v", err)
	}
}

// Complete 须返回 error（v0.69.1: (*ServerConfig).Complete() error），且填充默认 bindAddr。
func TestServerConfig_Complete(t *testing.T) {
	sc, err := ParseServerTOML([]byte("bindPort = 7000\n"))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if err := sc.Complete(); err != nil {
		t.Fatalf("complete: %v", err)
	}
	if sc.BindAddr == "" {
		t.Fatalf("Complete() 未填充默认 BindAddr")
	}
}
