package manager

import (
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/nue-mic/frps-manager/internal/eventbus"
	"github.com/nue-mic/frps-manager/pkg/config"
)

func newMgr(t *testing.T) (*Manager, string) {
	t.Helper()
	tmp := t.TempDir()
	opts := Options{
		ProfilesDir: filepath.Join(tmp, "profiles"),
		LogsDir:     filepath.Join(tmp, "logs"),
		StoresDir:   filepath.Join(tmp, "stores"),
		MetaPath:    filepath.Join(tmp, "meta.json"),
		Logger:      slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError})),
		Bus:         eventbus.New(16),
	}
	for _, d := range []string{opts.ProfilesDir, opts.LogsDir, opts.StoresDir} {
		_ = os.MkdirAll(d, 0o755)
	}
	m, err := New(opts)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return m, tmp
}

func serverCfg(t *testing.T, bindPort int) *config.ServerConfigV1 {
	t.Helper()
	sc, err := config.ParseServerTOML([]byte("bindPort = 7000\n"))
	if err != nil {
		t.Fatalf("ParseServerTOML: %v", err)
	}
	sc.BindPort = bindPort
	return sc
}

// TestCreateGetRoundTrip: Create 写盘后，Get 能读回 bindPort 与 frpsmgr 元数据。
func TestCreateGetRoundTrip(t *testing.T) {
	m, _ := newMgr(t)
	if err := m.Create("main", serverCfg(t, 7001), MgrMeta{Name: "主服务端", ManualStart: true}); err != nil {
		t.Fatalf("Create: %v", err)
	}

	snap, sc, mm, err := m.Get("main")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if sc.BindPort != 7001 {
		t.Fatalf("BindPort = %d, want 7001", sc.BindPort)
	}
	if mm.Name != "主服务端" || !mm.ManualStart {
		t.Fatalf("frpsmgr meta lost: %+v", mm)
	}
	if snap.Name != "主服务端" {
		t.Fatalf("snapshot name = %q, want 主服务端", snap.Name)
	}
	if snap.State != "stopped" {
		t.Fatalf("fresh instance state = %q, want stopped", snap.State)
	}
}

// TestCreateDuplicateRejected: 同 id 重复创建返回 ErrExists。
func TestCreateDuplicateRejected(t *testing.T) {
	m, _ := newMgr(t)
	if err := m.Create("dup", serverCfg(t, 7000), MgrMeta{}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := m.Create("dup", serverCfg(t, 7000), MgrMeta{}); err != ErrExists {
		t.Fatalf("expected ErrExists, got %v", err)
	}
}

// TestDeleteRemovesFileAndMeta: Delete 后文件消失、Get 404、meta 不再含该 id。
func TestDeleteRemovesFileAndMeta(t *testing.T) {
	m, tmp := newMgr(t)
	if err := m.Create("gone", serverCfg(t, 7000), MgrMeta{Name: "n"}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	path := filepath.Join(tmp, "profiles", "gone.toml")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("file should exist: %v", err)
	}
	if err := m.Delete("gone"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("file should be gone, stat err=%v", err)
	}
	if _, _, _, err := m.Get("gone"); err != ErrNotFound {
		t.Fatalf("expected ErrNotFound after delete, got %v", err)
	}
	if m.meta.name("gone") != "" {
		t.Fatalf("meta name not dropped")
	}
}

// TestListReflectsCreateAndReorder: List 返回创建的实例并尊重 Reorder 顺序。
func TestListReflectsCreateAndReorder(t *testing.T) {
	m, _ := newMgr(t)
	for _, id := range []string{"a", "b", "c"} {
		if err := m.Create(id, serverCfg(t, 7000), MgrMeta{Name: id}); err != nil {
			t.Fatalf("Create %s: %v", id, err)
		}
	}
	if err := m.Reorder([]string{"c", "a", "b"}); err != nil {
		t.Fatalf("Reorder: %v", err)
	}
	list := m.List()
	if len(list) != 3 {
		t.Fatalf("expected 3 items, got %d", len(list))
	}
	if list[0].ID != "c" || list[1].ID != "a" || list[2].ID != "b" {
		t.Fatalf("reorder not honored: %s,%s,%s", list[0].ID, list[1].ID, list[2].ID)
	}
}

// TestWriteRawRejectsGarbage: WriteRaw 对非法 TOML 返回 parse 错误。
func TestWriteRawRejectsGarbage(t *testing.T) {
	m, _ := newMgr(t)
	if err := m.Create("x", serverCfg(t, 7000), MgrMeta{}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := m.WriteRaw("x", []byte("this is = = not valid toml ===")); err == nil {
		t.Fatalf("expected parse error for garbage TOML")
	}
}
