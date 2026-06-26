package api

import (
	"io/fs"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/nue-mic/frps-manager/internal/api/middleware"
	"github.com/nue-mic/frps-manager/internal/appcfg"
	"github.com/nue-mic/frps-manager/internal/manager"
	"github.com/nue-mic/frps-manager/internal/metrics"
	"github.com/nue-mic/frps-manager/web"
)

// Deps bundles the collaborators that handlers need.
type Deps struct {
	Cfg     *appcfg.Config
	Logger  *slog.Logger
	Manager *manager.Manager
	Metrics *metrics.Store // may be nil if metrics disabled
	// LogLevel is the live logger level knob, so the runtime system-config
	// endpoint can change verbosity without a restart. May be nil.
	LogLevel *slog.LevelVar
}

// NewRouter assembles the chi mux with all middleware and route groups
// installed. It returns an http.Handler ready to be served.
func NewRouter(d Deps) http.Handler {
	r := chi.NewRouter()

	// Runtime config: env defaults overlaid with meta.json overrides, read live
	// by CORS / docs / self-update so a system-config UI change applies at once.
	rc := NewRuntimeConfig(d.Cfg, d.Manager, d.LogLevel)

	r.Use(middleware.Recover(d.Logger))
	r.Use(middleware.AccessLog(d.Logger))
	r.Use(middleware.CORS(rc.EffectiveCORS))

	sys := NewSystemHandler(d.Cfg.DataDir)
	docs := NewDocsHandler(rc.DocsEnabled)
	ui := NewUIHandler(d.Manager)

	// Unauthenticated probes + docs. The docs routes are always mounted; each
	// handler 404s per-request when docs are disabled, so the toggle is live.
	r.Get("/api/v1/health", sys.Health)
	// UI branding is read without auth so the login page + browser <title>
	// render the custom brand before the user is authenticated.
	r.Get("/api/v1/ui/branding", ui.GetBranding)
	r.Get("/api/docs", docs.Redirect)
	r.Get("/api/docs/", docs.UI)
	r.Get("/api/docs/openapi.yaml", docs.Spec)
	r.Get("/api/docs/openapi.json", docs.SpecJSON)

	configs := NewConfigsHandler(d.Manager, d.Logger)
	life := NewLifecycleHandler(d.Manager, d.Logger)
	status := NewStatusHandler(d.Manager)
	runtime := NewRuntimeHandler(d.Manager)
	validate := NewValidateHandler()
	events := NewEventsHandler(d.Manager, d.Logger, rc.EffectiveCORS)
	logs := NewLogsHandler(d.Manager, d.Cfg.LogsDir, d.Logger, rc.EffectiveCORS)
	imex := NewImportExportHandler(d.Manager, d.Logger)
	mh := NewMetricsHandler(d.Metrics)
	upd := NewUpdateHandler(d.Cfg.DataDir, rc.SelfUpdateEnabled, d.Logger)
	syscfg := NewSysConfigHandler(rc, d.Logger)

	// Authenticated subtree.
	r.Group(func(r chi.Router) {
		r.Use(middleware.Bearer(d.Cfg.APIToken))
		r.Get("/api/v1/version", sys.Version)
		r.Get("/api/v1/version/check", upd.Check)
		r.Post("/api/v1/system/update", upd.Update)
		r.Get("/api/v1/system/update/log", upd.Log)
		// 运行时系统配置（日志级别/自更新/文档/CORS），网页即时可调、免重启
		r.Get("/api/v1/system/config", syscfg.Get)
		r.Put("/api/v1/system/config", syscfg.Put)

		// UI 品牌持久化（品牌名 / 副标题 / 浏览器标题），仅鉴权后可改
		r.Put("/api/v1/ui/branding", ui.UpdateBranding)

		r.Get("/api/v1/configs", configs.List)
		r.Post("/api/v1/configs", configs.Create)
		r.Post("/api/v1/configs/reorder", configs.Reorder)
		r.Get("/api/v1/configs/{id}", configs.Get)
		r.Put("/api/v1/configs/{id}", configs.Update)
		r.Patch("/api/v1/configs/{id}", configs.Patch)
		r.Delete("/api/v1/configs/{id}", configs.Delete)
		r.Post("/api/v1/configs/{id}/duplicate", configs.Duplicate)
		r.Get("/api/v1/configs/{id}/raw", configs.GetRaw)
		r.Put("/api/v1/configs/{id}/raw", configs.PutRaw)

		r.Post("/api/v1/configs/{id}/start", life.Start)
		r.Post("/api/v1/configs/{id}/stop", life.Stop)
		r.Post("/api/v1/configs/{id}/reload", life.Reload)
		r.Get("/api/v1/configs/{id}/status", status.Get)

		// 运行时监控（只读，经 worker loopback 读 frps mem/clients）
		r.Get("/api/v1/runtime/{id}/overview", runtime.Overview)
		r.Get("/api/v1/runtime/{id}/proxies", runtime.Proxies)
		r.Get("/api/v1/runtime/{id}/proxies/{name}", runtime.ProxyByName)
		r.Get("/api/v1/runtime/{id}/clients", runtime.Clients)

		// 历史流量曲线
		r.Get("/api/v1/metrics/{id}/traffic", mh.Traffic)

		// 告警规则与事件
		r.Get("/api/v1/alerts/events", mh.AlertEvents)
		r.Get("/api/v1/alerts", mh.ListAlerts)
		r.Post("/api/v1/alerts", mh.CreateAlert)
		r.Get("/api/v1/alerts/{id}", mh.GetAlert)
		r.Put("/api/v1/alerts/{id}", mh.UpdateAlert)
		r.Delete("/api/v1/alerts/{id}", mh.DeleteAlert)

		r.Post("/api/v1/validate", validate.Validate)

		r.Get("/api/v1/configs/{id}/logs", logs.Query)
		r.Get("/api/v1/configs/{id}/logs/files", logs.Files)
		r.Delete("/api/v1/configs/{id}/logs", logs.Clear)
		r.Get("/api/v1/configs/{id}/logs/tail", logs.Tail)

		r.Get("/api/v1/events", events.Subscribe)

		r.Post("/api/v1/import/file", imex.ImportFile)
		r.Post("/api/v1/import/url", imex.ImportURL)
		r.Post("/api/v1/import/text", imex.ImportText)
		r.Post("/api/v1/import/zip", imex.ImportZIP)
		r.Get("/api/v1/configs/{id}/export", imex.ExportConfig)
		r.Get("/api/v1/export/all", imex.ExportAll)

		r.Get("/api/v1/system/info", sys.Info)
		r.Get("/api/v1/system/cpu", sys.CPU)
		r.Get("/api/v1/system/memory", sys.Memory)
		r.Get("/api/v1/system/disk", sys.Disk)
		r.Get("/api/v1/system/network", sys.Network)
		r.Get("/api/v1/system/connections", sys.Connections)
		r.Get("/api/v1/system/process", sys.Process)
	})

	// WebUI 静态文件分发 & SPA 路由兼容
	webFS := web.GetFS()
	fileServer := http.FileServer(http.FS(webFS))

	r.Get("/*", func(w http.ResponseWriter, r *http.Request) {
		// 如果是未匹配的 api 请求，不应该回退到前端，直接 404
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}

		filePath := strings.TrimPrefix(r.URL.Path, "/")

		// 真正存在的静态资源（hash 命名的 js/css/图片等）交给 FileServer 处理，
		// 保留其强缓存。index.html 例外——它要走下面的品牌注入分支。
		if filePath != "" && filePath != "index.html" {
			if f, err := webFS.Open(filePath); err == nil {
				f.Close()
				fileServer.ServeHTTP(w, r)
				return
			}
		}

		// index.html（根路径 "/"、显式 /index.html、或前端 BrowserRouter 深链接
		// 如 /configs）→ 读取内嵌 index.html，就地注入当前品牌（<title> +
		// window.__FRPS_BRANDING__）后写出，实现首屏零闪。
		//
		// 注意：不能改写成 r.URL.Path = "/index.html" 再走 FileServer——http.FileServer
		// 会把任何以 /index.html 结尾的请求 301 重定向到 "./"，导致刷新任意子页面都被
		// 重定向回首页。因此这里直接读取、注入并写出。
		index, err := fs.ReadFile(webFS, "index.html")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		out := ui.InjectBranding(index)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		// SPA 壳必须随取随新，确保品牌改动立即生效；静态资源仍走强缓存。
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(out)
	})

	return r
}
