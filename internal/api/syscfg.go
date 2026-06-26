package api

import (
	"log/slog"
	"net/http"
	"strings"

	"github.com/nue-mic/frps-manager/internal/api/middleware"
	"github.com/nue-mic/frps-manager/internal/appcfg"
	"github.com/nue-mic/frps-manager/internal/manager"
)

// validLogLevels are the accepted runtime log-level names.
var validLogLevels = map[string]struct{}{
	"trace": {}, "debug": {}, "info": {}, "warn": {}, "error": {},
}

// RuntimeConfig resolves the effective daemon settings by layering the
// operator's meta.json overrides on top of the FRPSMGR_* env defaults, and
// applies live changes (e.g. the logger level) without a restart. The
// effective getters are read live by the CORS middleware, the docs handler and
// the self-update handler so a UI change takes effect immediately.
type RuntimeConfig struct {
	cfg      *appcfg.Config // immutable env baseline
	mgr      *manager.Manager
	levelVar *slog.LevelVar // live logger level knob (may be nil)
}

// NewRuntimeConfig builds the resolver and re-applies any persisted log-level
// override to the live logger, so a UI-set level survives a daemon restart.
func NewRuntimeConfig(cfg *appcfg.Config, mgr *manager.Manager, levelVar *slog.LevelVar) *RuntimeConfig {
	rc := &RuntimeConfig{cfg: cfg, mgr: mgr, levelVar: levelVar}
	if levelVar != nil {
		levelVar.Set(appcfg.ParseLevel(rc.EffectiveLogLevel()))
	}
	return rc
}

// EffectiveLogLevel returns the override if set & non-empty, else the env value.
func (rc *RuntimeConfig) EffectiveLogLevel() string {
	if o := rc.mgr.GetSystemConfig().LogLevel; o != nil && strings.TrimSpace(*o) != "" {
		return strings.ToLower(strings.TrimSpace(*o))
	}
	return rc.cfg.LogLevel
}

// SelfUpdateEnabled returns the override if set, else the env value.
func (rc *RuntimeConfig) SelfUpdateEnabled() bool {
	if o := rc.mgr.GetSystemConfig().SelfUpdateEnabled; o != nil {
		return *o
	}
	return rc.cfg.SelfUpdateEnabled
}

// DocsEnabled returns the override if set, else the env value.
func (rc *RuntimeConfig) DocsEnabled() bool {
	if o := rc.mgr.GetSystemConfig().DocsEnabled; o != nil {
		return *o
	}
	return rc.cfg.DocsEnabled
}

// EffectiveCORS returns the override if set & meaningful, else the env value.
// Both branches are normalized (blanks dropped, any "*" collapses the list to
// the wildcard) so the HTTP middleware and the WS OriginPatterns can't disagree,
// and a persisted empty list (e.g. a hand-edited meta.json) degrades to "follow
// env" instead of locking out every browser.
func (rc *RuntimeConfig) EffectiveCORS() []string {
	if o := rc.mgr.GetSystemConfig().CORSOrigins; o != nil {
		if n := middleware.NormalizeOrigins(*o); len(n) > 0 {
			return n
		}
	}
	return middleware.NormalizeOrigins(rc.cfg.CORSOrigins)
}

// SysConfigHandler serves GET/PUT /api/v1/system/config.
type SysConfigHandler struct {
	rc  *RuntimeConfig
	log *slog.Logger
}

// NewSysConfigHandler wires the handler.
func NewSysConfigHandler(rc *RuntimeConfig, log *slog.Logger) *SysConfigHandler {
	return &SysConfigHandler{rc: rc, log: log}
}

// response renders effective values + which fields are overridden + the env
// defaults, so the UI can show current state and a "reset to env default" knob.
func (h *SysConfigHandler) response() map[string]any {
	raw := h.rc.mgr.GetSystemConfig()
	return map[string]any{
		"effective": map[string]any{
			"log_level":           h.rc.EffectiveLogLevel(),
			"self_update_enabled": h.rc.SelfUpdateEnabled(),
			"docs_enabled":        h.rc.DocsEnabled(),
			"cors_origins":        h.rc.EffectiveCORS(),
		},
		"env_default": map[string]any{
			"log_level":           h.rc.cfg.LogLevel,
			"self_update_enabled": h.rc.cfg.SelfUpdateEnabled,
			"docs_enabled":        h.rc.cfg.DocsEnabled,
			"cors_origins":        h.rc.cfg.CORSOrigins,
		},
		"overridden": map[string]any{
			"log_level":           raw.LogLevel != nil,
			"self_update_enabled": raw.SelfUpdateEnabled != nil,
			"docs_enabled":        raw.DocsEnabled != nil,
			"cors_origins":        raw.CORSOrigins != nil,
		},
	}
}

// Get returns the current effective system config.
func (h *SysConfigHandler) Get(w http.ResponseWriter, r *http.Request) {
	WriteJSON(w, http.StatusOK, h.response())
}

// Put merges the supplied overrides. A field present in the body sets/replaces
// that override; a field name listed in "reset" clears it back to the env
// default; fields neither present nor reset are left unchanged.
func (h *SysConfigHandler) Put(w http.ResponseWriter, r *http.Request) {
	var body struct {
		LogLevel          *string   `json:"log_level"`
		SelfUpdateEnabled *bool     `json:"self_update_enabled"`
		DocsEnabled       *bool     `json:"docs_enabled"`
		CORSOrigins       *[]string `json:"cors_origins"`
		Reset             []string  `json:"reset"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}

	if body.LogLevel != nil {
		lv := strings.ToLower(strings.TrimSpace(*body.LogLevel))
		if _, ok := validLogLevels[lv]; !ok {
			WriteError(w, http.StatusBadRequest, CodeBadRequest,
				"log_level 必须是 trace|debug|info|warn|error 之一", nil)
			return
		}
		*body.LogLevel = lv
	}
	if body.CORSOrigins != nil {
		clean := middleware.NormalizeOrigins(*body.CORSOrigins)
		if len(clean) == 0 {
			WriteError(w, http.StatusBadRequest, CodeBadRequest,
				"cors_origins 不能为空（用 \"*\" 放行全部，或在 reset 里清除该项以回退 env 默认）", nil)
			return
		}
		*body.CORSOrigins = clean
	}

	// reset wins over a same-field value in the same request: building the set
	// first keeps the merge deterministic regardless of map iteration order.
	reset := make(map[string]bool, len(body.Reset))
	for _, f := range body.Reset {
		reset[f] = true
	}

	// Merge under the store lock so two concurrent PUTs can't lose each other's
	// field updates (the read-modify-write stays a single critical section).
	if err := h.rc.mgr.UpdateSystemConfig(func(c *manager.SystemConfig) {
		if body.LogLevel != nil {
			c.LogLevel = body.LogLevel
		}
		if body.SelfUpdateEnabled != nil {
			c.SelfUpdateEnabled = body.SelfUpdateEnabled
		}
		if body.DocsEnabled != nil {
			c.DocsEnabled = body.DocsEnabled
		}
		if body.CORSOrigins != nil {
			c.CORSOrigins = body.CORSOrigins
		}
		if reset["log_level"] {
			c.LogLevel = nil
		}
		if reset["self_update_enabled"] {
			c.SelfUpdateEnabled = nil
		}
		if reset["docs_enabled"] {
			c.DocsEnabled = nil
		}
		if reset["cors_origins"] {
			c.CORSOrigins = nil
		}
	}); err != nil {
		WriteError(w, http.StatusInternalServerError, CodeInternal, "保存失败："+err.Error(), nil)
		return
	}
	// Apply the live knobs that can change without a restart.
	if h.rc.levelVar != nil {
		h.rc.levelVar.Set(appcfg.ParseLevel(h.rc.EffectiveLogLevel()))
	}
	h.log.Info("system config updated via web",
		slog.String("log_level", h.rc.EffectiveLogLevel()),
		slog.Bool("self_update", h.rc.SelfUpdateEnabled()),
		slog.Bool("docs", h.rc.DocsEnabled()))

	WriteJSON(w, http.StatusOK, h.response())
}
