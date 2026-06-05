package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"

	"github.com/mia-clark/frp-manager-server/internal/api/middleware"
	"github.com/mia-clark/frp-manager-server/internal/logtail"
	"github.com/mia-clark/frp-manager-server/internal/manager"
	"github.com/mia-clark/frp-manager-server/pkg/util"
)

// LogsHandler serves /api/v1/configs/{id}/logs*.
type LogsHandler struct {
	m       *manager.Manager
	logsDir string
	log     *slog.Logger
	origins []string
}

// NewLogsHandler builds a LogsHandler.
func NewLogsHandler(m *manager.Manager, logsDir string, log *slog.Logger, origins []string) *LogsHandler {
	return &LogsHandler{m: m, logsDir: logsDir, log: log, origins: origins}
}

// logInstancePath 返回单个实例的独立日志文件绝对路径。子进程模型下，每个
// frps worker 的 stdout/stderr 写入各自的 <id>.log，无需再按前缀过滤。
func (h *LogsHandler) logInstancePath(id string) string {
	return h.m.LogPath(id)
}

// Query returns the last `lines` lines (default 200) from this instance's
// log file that are not older than the instance's LogViewSince watermark.
func (h *LogsHandler) Query(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	if !h.m.Exists(id) {
		WriteError(w, http.StatusNotFound, CodeConfigNotFound, "config not found", nil)
		return
	}
	lines := atoiDefault(r.URL.Query().Get("lines"), 200)
	since := h.m.LogViewSince(id)

	got, err := util.ReadFileLinesFiltered(h.logInstancePath(id), lines, func(line string) bool {
		if since == 0 {
			return true
		}
		ts, ok := parseLogLineTimestamp(line)
		if !ok {
			return true // 解析失败的行保留，避免误删
		}
		return ts >= since
	})
	if err != nil {
		WriteJSON(w, http.StatusOK, map[string]any{"lines": []string{}, "next_offset": int64(0)})
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"lines":       trimLines(got),
		"next_offset": int64(0), // 合并日志模式不再支持 offset 翻页；前端只用 lines
	})
}

// Files 列出本实例日志文件 <id>.log 的所有轮转副本。子进程模型下，每个 frps
// worker 写各自的日志文件，本接口只列当前实例的归档。
func (h *LogsHandler) Files(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	if !h.m.Exists(id) {
		WriteError(w, http.StatusNotFound, CodeConfigNotFound, "config not found", nil)
		return
	}
	files, dates, err := util.FindLogFiles(h.logInstancePath(id))
	if err != nil {
		WriteJSON(w, http.StatusOK, map[string]any{"items": []any{}})
		return
	}
	items := make([]map[string]any, 0, len(files))
	for i, f := range files {
		entry := map[string]any{"path": f}
		if i < len(dates) && !dates[i].IsZero() {
			entry["rotated_at"] = dates[i]
		}
		items = append(items, entry)
	}
	WriteJSON(w, http.StatusOK, map[string]any{"items": items})
}

// Clear sets a "view since" timestamp for this instance instead of deleting
// the log file. Subsequent GET /logs and WS /logs/tail will skip lines older
// than this timestamp. The physical <id>.log is preserved so operators can
// still grep historical data on disk.
func (h *LogsHandler) Clear(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	if !h.m.Exists(id) {
		WriteError(w, http.StatusNotFound, CodeConfigNotFound, "config not found", nil)
		return
	}
	if err := h.m.SetLogViewSince(id, time.Now().UnixMilli()); err != nil {
		WriteError(w, http.StatusInternalServerError, "internal_error", err.Error(), nil)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Tail upgrades to WebSocket and streams new lines belonging to the given
// instance as they arrive. 订阅本实例的 <id>.log 文件，新增行实时推送。
// 当 LogViewSince[id] > 0 时，时间戳早于该值的行被丢弃。
func (h *LogsHandler) Tail(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	if !h.m.Exists(id) {
		WriteError(w, http.StatusNotFound, CodeConfigNotFound, "config not found", nil)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: middleware.IsWildcard(h.origins),
		OriginPatterns:     h.origins,
	})
	if err != nil {
		h.log.Warn("ws accept failed", slog.Any("err", err))
		return
	}
	defer conn.Close(websocket.StatusInternalError, "internal error")

	// CloseRead 在后台持续读取控制帧（ping/pong/close），返回一个在连接关闭时
	// 自动取消的 ctx。这样即便底层 TCP 已被 hijack（HTTP server 不再管理），
	// 客户端主动关闭连接也能让下方 select 及时退出。
	ctx := conn.CloseRead(r.Context())

	t := logtail.New(h.logInstancePath(id))
	ch := t.Subscribe()
	defer t.Stop()

	since := h.m.LogViewSince(id)

	ping := time.NewTicker(30 * time.Second)
	defer ping.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case line, ok := <-ch:
			if !ok {
				return
			}
			if since > 0 {
				if ts, ok := parseLogLineTimestamp(line); ok && ts < since {
					continue
				}
			}
			payload, _ := json.Marshal(map[string]string{"line": line})
			wctx, c := context.WithTimeout(ctx, 5*time.Second)
			if err := conn.Write(wctx, websocket.MessageText, payload); err != nil {
				c()
				return
			}
			c()
		case <-ping.C:
			pctx, c := context.WithTimeout(ctx, 5*time.Second)
			if err := conn.Ping(pctx); err != nil {
				c()
				return
			}
			c()
		}
	}
}

func atoiDefault(s string, def int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		return def
	}
	return n
}

func trimLines(in []string) []string {
	out := make([]string, 0, len(in))
	for _, l := range in {
		out = append(out, strings.TrimRight(l, "\r\n"))
	}
	return out
}

// parseLogLineTimestamp 从 frp 日志行首解析时间戳（毫秒精度）。
// frp 行格式："2026-06-03 15:18:20.546 [D] ..."（util.log 包默认 layout）。
// 解析失败时 ok=false，调用方应当默认保留这一行。
func parseLogLineTimestamp(line string) (unixMilli int64, ok bool) {
	const layout = "2006-01-02 15:04:05.000"
	if len(line) < len(layout) {
		return 0, false
	}
	t, err := time.ParseInLocation(layout, line[:len(layout)], time.Local)
	if err != nil {
		return 0, false
	}
	return t.UnixMilli(), true
}
