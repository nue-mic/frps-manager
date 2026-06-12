package manager

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 默认值：未自定义时 GetBranding 返回 Default* 常量。
// 往返：SetBranding 写入（含首尾空白被 trim）后重开 daemon 仍读回。
func TestBranding_RoundTripAndDefaults(t *testing.T) {
	tmp := t.TempDir()
	metaPath := filepath.Join(tmp, "meta.json")

	m, err := New(Options{MetaPath: metaPath})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if got := m.GetBranding(); got.AppName != DefaultAppName || got.AppSubtitle != DefaultAppSubtitle || got.HTMLTitle != DefaultHTMLTitle {
		t.Fatalf("default branding mismatch: %+v", got)
	}

	if _, err := m.SetBranding(Branding{AppName: "  我的内网穿透  ", AppSubtitle: " 服务端控制台 ", HTMLTitle: "我的内网穿透 · 控制台"}); err != nil {
		t.Fatalf("SetBranding: %v", err)
	}

	// 重新打开（模拟重启 / 清缓存重登）校验持久化
	m2, err := New(Options{MetaPath: metaPath})
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	got := m2.GetBranding()
	if got.AppName != "我的内网穿透" {
		t.Fatalf("AppName trim/persist failed: %q", got.AppName)
	}
	if got.AppSubtitle != "服务端控制台" {
		t.Fatalf("AppSubtitle trim/persist failed: %q", got.AppSubtitle)
	}
	if got.HTMLTitle != "我的内网穿透 · 控制台" {
		t.Fatalf("HTMLTitle persist failed: %q", got.HTMLTitle)
	}
}

// 清空某字段（仅空白）→ 读回应回退到默认，另一字段保持。
func TestBranding_EmptyResetsToDefault(t *testing.T) {
	tmp := t.TempDir()
	metaPath := filepath.Join(tmp, "meta.json")
	m, err := New(Options{MetaPath: metaPath})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := m.SetBranding(Branding{AppName: "X", HTMLTitle: "Y"}); err != nil {
		t.Fatalf("SetBranding: %v", err)
	}
	if _, err := m.SetBranding(Branding{AppName: "   ", HTMLTitle: "Y"}); err != nil {
		t.Fatalf("SetBranding(empty): %v", err)
	}
	got := m.GetBranding()
	if got.AppName != DefaultAppName {
		t.Fatalf("empty AppName should reset to default, got %q", got.AppName)
	}
	if got.HTMLTitle != "Y" {
		t.Fatalf("HTMLTitle should remain Y, got %q", got.HTMLTitle)
	}
}

// 超长品牌名按“字符（rune）”截断，不在多字节 CJK 中间切断。
func TestBranding_TruncateRunes(t *testing.T) {
	out := truncateRunes(strings.Repeat("名", 100), 40)
	if n := len([]rune(out)); n != 40 {
		t.Fatalf("expected 40 runes, got %d", n)
	}
}

// 旧 meta.json 不含 branding 字段时，GetBranding 仍返回默认值且不崩。
func TestBranding_BackwardCompatRead(t *testing.T) {
	tmp := t.TempDir()
	metaPath := filepath.Join(tmp, "meta.json")
	old := `{"version":1,"auto_start":[],"sort":[]}`
	if err := os.WriteFile(metaPath, []byte(old), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	m, err := New(Options{MetaPath: metaPath})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if got := m.GetBranding(); got.AppName != DefaultAppName || got.AppSubtitle != DefaultAppSubtitle || got.HTMLTitle != DefaultHTMLTitle {
		t.Fatalf("old meta.json should yield defaults, got %+v", got)
	}
}
