package api

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strconv"

	"github.com/nue-mic/frps-manager/internal/metrics"
)

// MetricsHandler serves /api/v1/metrics/* (history traffic) and /api/v1/alerts/*
// (alert rule CRUD + events), backed by the SQLite metrics store.
type MetricsHandler struct {
	store *metrics.Store
}

// NewMetricsHandler builds a MetricsHandler. store may be nil if metrics are
// disabled; handlers then return 503.
func NewMetricsHandler(store *metrics.Store) *MetricsHandler {
	return &MetricsHandler{store: store}
}

func (h *MetricsHandler) ready(w http.ResponseWriter) bool {
	if h.store == nil {
		WriteError(w, http.StatusServiceUnavailable, CodeInternal, "metrics store disabled", nil)
		return false
	}
	return true
}

// Traffic returns downsampled historical traffic for one (inst,scope,key).
// Query: scope=server|proxy (default server), key=<proxy name> (default ""),
// from,to (unix sec), step (sec, default 60).
func (h *MetricsHandler) Traffic(w http.ResponseWriter, r *http.Request) {
	if !h.ready(w) {
		return
	}
	id := pathID(r)
	q := r.URL.Query()
	scope := q.Get("scope")
	if scope == "" {
		scope = "server"
	}
	key := q.Get("key")
	from := atoi64(q.Get("from"), 0)
	to := atoi64(q.Get("to"), 0)
	step := atoi64(q.Get("step"), 60)
	if to == 0 {
		WriteError(w, http.StatusBadRequest, CodeBadRequest, "to (unix sec) is required", nil)
		return
	}
	series, err := h.store.QueryTraffic(id, scope, key, from, to, step)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, CodeInternal, err.Error(), nil)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"inst_id": id, "scope": scope, "key": key, "step": step, "points": series,
	})
}

// ListAlerts returns all alert rules.
func (h *MetricsHandler) ListAlerts(w http.ResponseWriter, r *http.Request) {
	if !h.ready(w) {
		return
	}
	rules, err := h.store.ListRules()
	if err != nil {
		WriteError(w, http.StatusInternalServerError, CodeInternal, err.Error(), nil)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"items": rules})
}

// CreateAlert creates a new alert rule (id auto-generated if absent).
func (h *MetricsHandler) CreateAlert(w http.ResponseWriter, r *http.Request) {
	if !h.ready(w) {
		return
	}
	var rule metrics.AlertRule
	if !decodeJSON(w, r, &rule) {
		return
	}
	if rule.ID == "" {
		rule.ID = "rule_" + randHex(6)
	}
	if rule.Name == "" || rule.Metric == "" || rule.Op == "" {
		WriteError(w, http.StatusBadRequest, CodeBadRequest, "name, metric and op are required", nil)
		return
	}
	if rule.InstID == "" {
		rule.InstID = "*"
	}
	if err := h.store.UpsertRule(rule); err != nil {
		WriteError(w, http.StatusInternalServerError, CodeInternal, err.Error(), nil)
		return
	}
	WriteJSON(w, http.StatusCreated, rule)
}

// GetAlert returns one rule.
func (h *MetricsHandler) GetAlert(w http.ResponseWriter, r *http.Request) {
	if !h.ready(w) {
		return
	}
	rule, ok, err := h.store.GetRule(pathID(r))
	if err != nil {
		WriteError(w, http.StatusInternalServerError, CodeInternal, err.Error(), nil)
		return
	}
	if !ok {
		WriteError(w, http.StatusNotFound, CodeConfigNotFound, "alert rule not found", nil)
		return
	}
	WriteJSON(w, http.StatusOK, rule)
}

// UpdateAlert replaces a rule (id from path).
func (h *MetricsHandler) UpdateAlert(w http.ResponseWriter, r *http.Request) {
	if !h.ready(w) {
		return
	}
	id := pathID(r)
	var rule metrics.AlertRule
	if !decodeJSON(w, r, &rule) {
		return
	}
	rule.ID = id
	if rule.InstID == "" {
		rule.InstID = "*"
	}
	if err := h.store.UpsertRule(rule); err != nil {
		WriteError(w, http.StatusInternalServerError, CodeInternal, err.Error(), nil)
		return
	}
	WriteJSON(w, http.StatusOK, rule)
}

// DeleteAlert removes a rule.
func (h *MetricsHandler) DeleteAlert(w http.ResponseWriter, r *http.Request) {
	if !h.ready(w) {
		return
	}
	if err := h.store.DeleteRule(pathID(r)); err != nil {
		WriteError(w, http.StatusInternalServerError, CodeInternal, err.Error(), nil)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// AlertEvents returns fired/resolved alert events, filtered by state/time.
func (h *MetricsHandler) AlertEvents(w http.ResponseWriter, r *http.Request) {
	if !h.ready(w) {
		return
	}
	q := r.URL.Query()
	events, err := h.store.ListEvents(q.Get("state"), atoi64(q.Get("from"), 0), atoi64(q.Get("to"), 0))
	if err != nil {
		WriteError(w, http.StatusInternalServerError, CodeInternal, err.Error(), nil)
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"items": events})
}

func atoi64(s string, def int64) int64 {
	if s == "" {
		return def
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return def
	}
	return n
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
