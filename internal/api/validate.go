package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	fvalidation "github.com/fatedier/frp/pkg/config/v1/validation"

	"github.com/nue-mic/frps-manager/pkg/config"
)

// ValidateHandler serves POST /api/v1/validate. It accepts either JSON
// (Content-Type application/json) carrying a ServerConfigV1 body, or raw
// frps TOML bytes (any other Content-Type).
type ValidateHandler struct{}

// NewValidateHandler builds a ValidateHandler.
func NewValidateHandler() *ValidateHandler { return &ValidateHandler{} }

type validateResp struct {
	Valid    bool     `json:"valid"`
	Errors   []string `json:"errors,omitempty"`
	Warnings []string `json:"warnings,omitempty"`
}

// Validate parses and validates a frps server config without persisting it.
func (h *ValidateHandler) Validate(w http.ResponseWriter, r *http.Request) {
	ct := r.Header.Get("Content-Type")
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		WriteError(w, http.StatusBadRequest, CodeBadRequest, "read body: "+err.Error(), nil)
		return
	}

	var sc *config.ServerConfigV1
	if strings.Contains(ct, "application/json") {
		var v config.ServerConfigV1
		if jerr := json.Unmarshal(body, &v); jerr != nil {
			WriteJSON(w, http.StatusOK, validateResp{Valid: false, Errors: []string{jerr.Error()}})
			return
		}
		sc = &v
	} else {
		parsed, perr := config.ParseServerTOML(body)
		if perr != nil {
			WriteJSON(w, http.StatusOK, validateResp{Valid: false, Errors: []string{perr.Error()}})
			return
		}
		sc = parsed
	}

	if err := sc.Complete(); err != nil {
		WriteJSON(w, http.StatusOK, validateResp{Valid: false, Errors: []string{err.Error()}})
		return
	}

	var validator fvalidation.ConfigValidator
	warning, verr := validator.ValidateServerConfig(&sc.ServerConfig)
	if verr != nil {
		WriteJSON(w, http.StatusOK, validateResp{Valid: false, Errors: []string{verr.Error()}})
		return
	}
	resp := validateResp{Valid: true}
	if warning != nil {
		resp.Warnings = []string{warning.Error()}
	}
	WriteJSON(w, http.StatusOK, resp)
}
