package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/nue-mic/frps-manager/internal/manager"
)

// RuntimeHandler serves the read-only /api/v1/runtime/{id}/* endpoints. For
// frps, proxies/clients/traffic are registered by clients at runtime and are
// NOT derivable from config — they live in the frps process's mem collector,
// reachable only via that worker's loopback webServer. This handler fetches
// them on demand over loopback HTTP (HTTP Basic) and forwards the result.
type RuntimeHandler struct {
	m      *manager.Manager
	client *http.Client
}

// NewRuntimeHandler builds a RuntimeHandler.
func NewRuntimeHandler(m *manager.Manager) *RuntimeHandler {
	return &RuntimeHandler{m: m, client: &http.Client{Timeout: 5 * time.Second}}
}

// frpsProxyTypes is the set of proxy types frps exposes under /api/proxy/{type}.
var frpsProxyTypes = []string{"tcp", "udp", "http", "https", "stcp", "sudp", "xtcp", "tcpmux"}

// loopbackGet performs an authenticated GET against the worker's loopback
// frps webServer and returns the raw response body. apiPath is e.g.
// "/api/serverinfo". ok=false (with written error) if not running.
func (h *RuntimeHandler) loopbackGet(w http.ResponseWriter, id, apiPath string) ([]byte, bool) {
	addr, user, pass, ok := h.m.Loopback(id)
	if !ok {
		if !h.m.Exists(id) {
			WriteError(w, http.StatusNotFound, CodeConfigNotFound, "config not found", nil)
		} else {
			WriteError(w, http.StatusConflict, CodeInvalidState, "instance is not running", nil)
		}
		return nil, false
	}
	req, err := http.NewRequest(http.MethodGet, "http://"+addr+apiPath, nil)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, CodeInternal, err.Error(), nil)
		return nil, false
	}
	req.SetBasicAuth(user, pass)
	resp, err := h.client.Do(req)
	if err != nil {
		WriteError(w, http.StatusBadGateway, CodeUpstreamFailure, "loopback request failed: "+err.Error(), nil)
		return nil, false
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode != http.StatusOK {
		WriteError(w, http.StatusBadGateway, CodeUpstreamFailure,
			fmt.Sprintf("frps loopback %s returned %d", apiPath, resp.StatusCode), nil)
		return nil, false
	}
	return body, true
}

// Overview proxies frps /api/serverinfo (totals, today traffic, proxy type counts).
func (h *RuntimeHandler) Overview(w http.ResponseWriter, r *http.Request) {
	body, ok := h.loopbackGet(w, pathID(r), "/api/serverinfo")
	if !ok {
		return
	}
	writeRawJSON(w, body)
}

// Clients proxies frps /api/clients (active client connections).
func (h *RuntimeHandler) Clients(w http.ResponseWriter, r *http.Request) {
	body, ok := h.loopbackGet(w, pathID(r), "/api/clients")
	if !ok {
		return
	}
	writeRawJSON(w, body)
}

// ProxyByName proxies frps /api/proxies/{name} — single active proxy by name
// across all types. Returns frps native proxy detail JSON (camelCase).
//
// Maps frps upstream 404 to this endpoint's 404 (proxy_not_found) so callers
// get a clean semantic instead of 502 upstream_failure.
func (h *RuntimeHandler) ProxyByName(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	name := pathName(r)
	if name == "" {
		WriteError(w, http.StatusBadRequest, CodeBadRequest, "proxy name is required", nil)
		return
	}
	addr, user, pass, ok := h.m.Loopback(id)
	if !ok {
		if !h.m.Exists(id) {
			WriteError(w, http.StatusNotFound, CodeConfigNotFound, "config not found", nil)
		} else {
			WriteError(w, http.StatusConflict, CodeInvalidState, "instance is not running", nil)
		}
		return
	}
	req, err := http.NewRequest(http.MethodGet, "http://"+addr+"/api/proxies/"+name, nil)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, CodeInternal, err.Error(), nil)
		return
	}
	req.SetBasicAuth(user, pass)
	resp, err := h.client.Do(req)
	if err != nil {
		WriteError(w, http.StatusBadGateway, CodeUpstreamFailure, "loopback request failed: "+err.Error(), nil)
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	switch resp.StatusCode {
	case http.StatusOK:
		writeRawJSON(w, body)
	case http.StatusNotFound:
		WriteError(w, http.StatusNotFound, CodeProxyNotFound, "proxy not found: "+name, nil)
	default:
		WriteError(w, http.StatusBadGateway, CodeUpstreamFailure,
			fmt.Sprintf("frps loopback returned %d for proxy %s", resp.StatusCode, name), nil)
	}
}

// Proxies aggregates frps /api/proxy/{type} across all proxy types into one
// flat list of active proxies.
func (h *RuntimeHandler) Proxies(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	// Probe running state once via the first call so we surface 404/409 cleanly.
	all := make([]json.RawMessage, 0)
	for i, typ := range frpsProxyTypes {
		body, ok := h.loopbackGet(w, id, "/api/proxy/"+typ)
		if !ok {
			if i == 0 {
				return // error already written (not running / not found)
			}
			continue // a single type failing shouldn't kill the whole list
		}
		var parsed struct {
			Proxies []json.RawMessage `json:"proxies"`
		}
		if err := json.Unmarshal(body, &parsed); err != nil {
			continue
		}
		all = append(all, parsed.Proxies...)
	}
	WriteJSON(w, http.StatusOK, map[string]any{"proxies": all})
}

// writeRawJSON forwards a JSON body verbatim with the right content type.
func writeRawJSON(w http.ResponseWriter, body []byte) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}
