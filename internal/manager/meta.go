package manager

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Meta is the persisted daemon-level metadata stored at /data/meta.json.
// It tracks the user-defined display order. Whether an instance auto-
// starts on daemon boot is now driven by frpsmgr.manualStart inside each
// config file; the legacy AutoStart list is kept only so old meta.json
// files round-trip without losing the key.
type Meta struct {
	Version      int               `json:"version"`
	AutoStart    []string          `json:"auto_start"`
	Sort         []string          `json:"sort"`
	LogViewSince map[string]int64  `json:"log_view_since,omitempty"`
	Names        map[string]string `json:"names,omitempty"`
	Manual       map[string]bool   `json:"manual,omitempty"`
	// Branding holds the operator-customizable UI brand name, subtitle and
	// browser title. nil / empty fields resolve to the Default* constants on read.
	Branding *Branding `json:"branding,omitempty"`
}

// Branding is the persisted, operator-editable UI branding. Stored inside
// meta.json so it survives browser cache clears and re-logins. Empty fields
// resolve to the Default* constants via Effective().
type Branding struct {
	AppName     string `json:"app_name,omitempty"`
	AppSubtitle string `json:"app_subtitle,omitempty"`
	HTMLTitle   string `json:"html_title,omitempty"`
}

// Default branding values — the single source of truth, matching the strings
// the frontend previously hard-coded. Used as fallback whenever a field is
// unset/empty, so an un-customized deployment looks exactly as before.
const (
	DefaultAppName     = "FRPS Manager"
	DefaultAppSubtitle = "服务端管理面板"
	DefaultHTMLTitle   = "FRPS Manager · 服务端管理面板"
)

// Effective returns a copy with every empty field filled from the defaults,
// i.e. a branding that is always safe to render directly.
func (b Branding) Effective() Branding {
	out := b
	if strings.TrimSpace(out.AppName) == "" {
		out.AppName = DefaultAppName
	}
	if strings.TrimSpace(out.AppSubtitle) == "" {
		out.AppSubtitle = DefaultAppSubtitle
	}
	if strings.TrimSpace(out.HTMLTitle) == "" {
		out.HTMLTitle = DefaultHTMLTitle
	}
	return out
}

func defaultMeta() *Meta {
	return &Meta{
		Version:      1,
		AutoStart:    []string{},
		Sort:         []string{},
		LogViewSince: map[string]int64{},
		Names:        map[string]string{},
		Manual:       map[string]bool{},
	}
}

type metaStore struct {
	path string
	mu   sync.Mutex
	data *Meta
}

func openMetaStore(path string) (*metaStore, error) {
	s := &metaStore{path: path, data: defaultMeta()}
	b, err := os.ReadFile(path)
	switch {
	case err == nil:
		_ = json.Unmarshal(b, s.data)
		if s.data.Version == 0 {
			s.data.Version = 1
		}
		if s.data.AutoStart == nil {
			s.data.AutoStart = []string{}
		}
		if s.data.Sort == nil {
			s.data.Sort = []string{}
		}
		if s.data.LogViewSince == nil {
			s.data.LogViewSince = map[string]int64{}
		}
		// R5: 旧 meta.json 没有 names/manual，读出来是 nil map，写入会 panic。
		if s.data.Names == nil {
			s.data.Names = map[string]string{}
		}
		if s.data.Manual == nil {
			s.data.Manual = map[string]bool{}
		}
	case errors.Is(err, os.ErrNotExist):
		// fresh install; write a stub so operators can see the file
		if err := s.flushLocked(); err != nil {
			return nil, err
		}
	default:
		return nil, err
	}
	return s, nil
}

func (s *metaStore) snapshot() Meta {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := *s.data
	m.AutoStart = append([]string(nil), s.data.AutoStart...)
	m.Sort = append([]string(nil), s.data.Sort...)
	m.LogViewSince = make(map[string]int64, len(s.data.LogViewSince))
	for k, v := range s.data.LogViewSince {
		m.LogViewSince[k] = v
	}
	if s.data.Branding != nil {
		b := *s.data.Branding
		m.Branding = &b
	}
	return m
}

// branding returns the raw stored branding (no defaults applied). A zero
// value means nothing has been customized yet.
func (s *metaStore) branding() Branding {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.Branding == nil {
		return Branding{}
	}
	return *s.data.Branding
}

// setBranding persists the branding wholesale (atomic write).
func (s *metaStore) setBranding(b Branding) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	bc := b
	s.data.Branding = &bc
	return s.flushLocked()
}

func (s *metaStore) setSort(order []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.Sort = append([]string(nil), order...)
	return s.flushLocked()
}

// dropIDs removes id from both AutoStart and Sort. Used after a config
// file is deleted.
func (s *metaStore) dropIDs(ids ...string) error {
	if len(ids) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	idset := make(map[string]struct{}, len(ids))
	for _, x := range ids {
		idset[x] = struct{}{}
	}
	s.data.AutoStart = filterOut(s.data.AutoStart, idset)
	s.data.Sort = filterOut(s.data.Sort, idset)
	for id := range idset {
		delete(s.data.LogViewSince, id)
		delete(s.data.Names, id)
		delete(s.data.Manual, id)
	}
	return s.flushLocked()
}

// name returns the display name recorded for id ("" if none).
func (s *metaStore) name(id string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data.Names[id]
}

// setName records the display name for id.
func (s *metaStore) setName(id, name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.Names == nil {
		s.data.Names = map[string]string{}
	}
	s.data.Names[id] = name
	return s.flushLocked()
}

// manualStart reports whether id is marked manual-start (no auto-start on boot).
func (s *metaStore) manualStart(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data.Manual[id]
}

// setManualStart records the manual-start flag for id.
func (s *metaStore) setManualStart(id string, v bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.Manual == nil {
		s.data.Manual = map[string]bool{}
	}
	s.data.Manual[id] = v
	return s.flushLocked()
}

func (s *metaStore) flushLocked() error {
	tmp := s.path + ".tmp"
	b, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// setLogViewSince 记录"用户在 unixMilli 时刻清空了 id 的日志视图"。
// GET /logs 和 WS /logs/tail 后续会跳过时间戳早于此值的行，达到逻辑清空效果。
func (s *metaStore) setLogViewSince(id string, unixMilli int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.LogViewSince == nil {
		s.data.LogViewSince = map[string]int64{}
	}
	s.data.LogViewSince[id] = unixMilli
	return s.flushLocked()
}

// logViewSince 读取指定 id 的清空戳；不存在返回 0（表示"显示所有历史"）。
func (s *metaStore) logViewSince(id string) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data.LogViewSince[id]
}

func filterOut(src []string, drop map[string]struct{}) []string {
	out := src[:0:0]
	for _, x := range src {
		if _, ok := drop[x]; ok {
			continue
		}
		out = append(out, x)
	}
	return out
}
