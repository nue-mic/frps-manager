package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/nue-mic/frps-manager/internal/api"
	"github.com/nue-mic/frps-manager/internal/appcfg"
	"github.com/nue-mic/frps-manager/internal/eventbus"
	"github.com/nue-mic/frps-manager/internal/manager"
	"github.com/nue-mic/frps-manager/internal/metrics"
	"github.com/nue-mic/frps-manager/pkg/version"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "serve":
		os.Exit(runServe(os.Args[2:]))
	case "frps-worker":
		os.Exit(runFrpsWorker(os.Args[2:]))
	case "health":
		os.Exit(runHealth(os.Args[2:]))
	case "version", "-v", "--version":
		fmt.Printf("frpsmgrd %s (frp %s, built %s)\n", version.Number, version.FRPVersion, version.BuildDate)
	case "help", "-h", "--help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n\n", os.Args[1])
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `frpsmgrd — headless FRP client manager daemon

USAGE
  frpsmgrd <command> [flags]

COMMANDS
  serve     Run the HTTP API server (default for containers)
  health    Probe /api/v1/health and exit non-zero on failure
  version   Print version information
  help      Show this help

ENV
  FRPSMGR_API_TOKEN       Required. Bearer token for API auth.
  FRPSMGR_HTTP_ADDR       Listen address (default ":8080")
  FRPSMGR_DATA_DIR        Data root (default "/data")
  FRPSMGR_CORS_ORIGINS    Comma-separated origins or "*" (default "*")
  FRPSMGR_LOG_LEVEL       trace|debug|info|warn|error (default "info")
  FRPSMGR_DOCS_ENABLED    Expose /api/docs Scalar UI (default "true")`)
}

func runServe(args []string) int {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	_ = fs.Parse(args)

	cfg, err := appcfg.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "config error: %v\n", err)
		return 1
	}
	if err := cfg.EnsureDirs(); err != nil {
		fmt.Fprintf(os.Stderr, "cannot create data dirs: %v\n", err)
		return 1
	}

	logger, levelVar := newLogger(cfg.LogLevel)
	// Surface any FRPSMGR_HTTP_ADDR normalization warning now that the logger
	// exists (appcfg.Load runs before the logger is built, so it can only stash
	// the text). Non-empty means the value was left as-is for net.Listen to
	// reject — better a visible error than silently binding the default port.
	if cfg.HTTPAddrWarn != "" {
		logger.Warn("listen addr normalize", slog.String("detail", cfg.HTTPAddrWarn))
	}
	logger.Info("starting frpsmgrd",
		slog.String("addr", cfg.HTTPAddr),
		slog.String("data_dir", cfg.DataDir),
		slog.String("version", version.Number),
		slog.String("frp", version.FRPVersion),
	)

	bus := eventbus.New(1024)
	mgr, err := manager.New(manager.Options{
		ProfilesDir: cfg.ProfilesDir,
		LogsDir:     cfg.LogsDir,
		StoresDir:   cfg.StoresDir,
		MetaPath:    cfg.MetaFile,
		Logger:      logger,
		Bus:         bus,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "init manager: %v\n", err)
		return 1
	}
	if err := mgr.LoadAll(); err != nil {
		fmt.Fprintf(os.Stderr, "load configs: %v\n", err)
		return 1
	}
	mgr.AutoStart()
	defer mgr.Shutdown()

	// 时序指标存储 + 采样器（P3）：纯 Go SQLite，落 $DataDir/metrics.db。
	// 采样器经各 worker loopback 每 10s 读 frps mem 指标 → 落库 + 评估告警。
	mstore, err := metrics.Open(filepath.Join(cfg.DataDir, "metrics.db"))
	if err != nil {
		logger.Warn("metrics store disabled", slog.Any("err", err))
		mstore = nil
	} else {
		defer mstore.Close()
		sampler := metrics.NewSampler(mstore, mgr, bus, logger, 10*time.Second, 7*24*time.Hour)
		samplerCtx, cancelSampler := context.WithCancel(context.Background())
		defer cancelSampler()
		go sampler.Run(samplerCtx)
	}

	handler := api.NewRouter(api.Deps{Cfg: cfg, Logger: logger, Manager: mgr, Metrics: mstore, LogLevel: levelVar})
	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	select {
	case sig := <-sigCh:
		logger.Info("shutdown signal received", slog.String("signal", sig.String()))
	case err := <-errCh:
		logger.Error("http server crashed", slog.Any("err", err))
		return 1
	}

	ctx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownWait)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		logger.Error("graceful shutdown failed", slog.Any("err", err))
		return 1
	}
	logger.Info("bye")
	return 0
}

func runHealth(args []string) int {
	fs := flag.NewFlagSet("health", flag.ExitOnError)
	addr := fs.String("addr", "http://127.0.0.1:8080", "daemon base URL")
	_ = fs.Parse(args)

	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(*addr + "/api/v1/health")
	if err != nil {
		fmt.Fprintf(os.Stderr, "health check failed: %v\n", err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "unhealthy: status=%d\n", resp.StatusCode)
		return 1
	}
	return 0
}

// newLogger builds the process logger backed by a *slog.LevelVar, returned
// alongside so the runtime system-config endpoint can change verbosity live
// (no restart). The initial level comes from FRPSMGR_LOG_LEVEL; a persisted
// meta.json override is re-applied later by api.NewRuntimeConfig.
func newLogger(level string) (*slog.Logger, *slog.LevelVar) {
	lv := new(slog.LevelVar)
	lv.Set(appcfg.ParseLevel(level))
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: lv}))
	return logger, lv
}
