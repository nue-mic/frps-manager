package manager

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"sync"
	"time"

	"github.com/nue-mic/frps-manager/internal/eventbus"
	"github.com/nue-mic/frps-manager/pkg/consts"
	"github.com/nue-mic/frps-manager/pkg/util"
)

// instance owns a single frps server lifecycle. Unlike the old frpc model
// (one in-process client.Service + status poller), each running frps lives
// in its own re-exec'd child process (frps-worker) — because frps's
// mem.StatsCollector is a process-global singleton and cannot separate
// metrics across multiple in-process servers. The Manager holds these
// inside a map keyed by config id.
type instance struct {
	id   string
	path string

	mu      sync.RWMutex
	state   consts.ConfigState
	lastErr string
	startAt time.Time
	stopAt  time.Time

	// run-time fields (zero unless running)
	w      *worker
	cancel context.CancelFunc

	logger  *slog.Logger
	bus     *eventbus.Bus
	selfExe string
	logSink io.Writer
}

func newInstance(id, path string, logger *slog.Logger, bus *eventbus.Bus, selfExe string, logSink io.Writer) *instance {
	return &instance{
		id:      id,
		path:    path,
		state:   consts.ConfigStateStopped,
		logger:  logger.With(slog.String("config_id", id)),
		bus:     bus,
		selfExe: selfExe,
		logSink: logSink,
	}
}

// ID returns the immutable config id (file stem).
func (i *instance) ID() string { return i.id }

// Path returns the absolute path of the underlying .toml file.
func (i *instance) Path() string { return i.path }

// Snapshot describes the run-time status of one instance. Per-proxy runtime
// data is no longer part of this snapshot — for frps, proxies are registered
// by clients at runtime and are surfaced via the read-only /runtime endpoints
// (P2), not derived from the config.
type Snapshot struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Path      string     `json:"path"`      // toml 配置文件路径
	LogPath   string     `json:"log_path"`  // 管理器接管该实例 worker 输出的日志文件路径
	State     string     `json:"state"`
	LastError string     `json:"last_error,omitempty"`
	StartedAt *time.Time `json:"started_at,omitempty"`
	StoppedAt *time.Time `json:"stopped_at,omitempty"`
}

// Snapshot returns a JSON-friendly status view. Name is left empty here and
// injected by the Manager from meta.json (the instance no longer holds config
// data in memory).
func (i *instance) Snapshot() Snapshot {
	i.mu.RLock()
	defer i.mu.RUnlock()
	s := Snapshot{
		ID:        i.id,
		Path:      i.path,
		State:     stateString(i.state),
		LastError: i.lastErr,
	}
	if !i.startAt.IsZero() {
		t := i.startAt
		s.StartedAt = &t
	}
	if !i.stopAt.IsZero() {
		t := i.stopAt
		s.StoppedAt = &t
	}
	return s
}

// State returns the current lifecycle state.
func (i *instance) State() consts.ConfigState {
	i.mu.RLock()
	defer i.mu.RUnlock()
	return i.state
}

// setState assigns a new state under lock and returns whether it changed.
func (i *instance) setState(s consts.ConfigState) bool {
	i.mu.Lock()
	prev := i.state
	if i.state == s {
		i.mu.Unlock()
		return false
	}
	i.state = s
	switch s {
	case consts.ConfigStateStarted:
		i.startAt = time.Now()
	case consts.ConfigStateStopped:
		i.stopAt = time.Now()
	}
	i.mu.Unlock()
	if i.bus != nil {
		i.bus.Publish(eventbus.TypeInstanceState, i.id, eventbus.InstanceStateData{
			State:     stateString(s),
			PrevState: stateString(prev),
		})
	}
	return true
}

// start spawns the frps worker child process and waits for its handshake.
// It is a no-op if the instance is already running.
func (i *instance) start(ctx context.Context) error {
	i.mu.Lock()
	if i.state == consts.ConfigStateStarted || i.state == consts.ConfigStateStarting {
		i.mu.Unlock()
		return errors.New("already running")
	}
	i.state = consts.ConfigStateStarting
	i.lastErr = ""
	i.mu.Unlock()

	runCtx, cancel := context.WithCancel(ctx)
	w, err := spawnWorker(runCtx, i.id, i.selfExe, i.path, i.logSink)
	if err != nil {
		cancel()
		i.recordError(err)
		i.setState(consts.ConfigStateStopped)
		return fmt.Errorf("spawn frps worker: %w", err)
	}
	i.mu.Lock()
	i.w = w
	i.cancel = cancel
	i.mu.Unlock()

	// Watch for child exit (crash / self-exit) → sync state. reap() is the
	// sole owner of cmd.Wait(); stop() coordinates via the worker's done chan.
	go func() {
		w.reap()
		i.mu.Lock()
		stopping := i.state == consts.ConfigStateStopping
		i.w = nil
		i.cancel = nil
		i.mu.Unlock()
		cancel()
		if !stopping {
			i.setState(consts.ConfigStateStopped)
			i.logger.Info("frps worker exited")
		}
	}()

	i.setState(consts.ConfigStateStarted)
	i.logger.Info("frps instance started", slog.String("loopback", w.hs.Addr))
	return nil
}

// stop terminates the worker child process and waits for it to be reaped.
func (i *instance) stop() error {
	i.mu.Lock()
	if i.state == consts.ConfigStateStopped || i.state == consts.ConfigStateStopping {
		i.mu.Unlock()
		return nil
	}
	i.state = consts.ConfigStateStopping
	cancel := i.cancel
	w := i.w
	i.mu.Unlock()

	if w != nil {
		_ = w.stop()
	}
	if cancel != nil {
		cancel()
	}
	i.mu.Lock()
	i.w = nil
	i.cancel = nil
	i.mu.Unlock()
	i.setState(consts.ConfigStateStopped)
	i.logger.Info("frps instance stopped")
	return nil
}

// reload for frps means restart: server-side parameter changes require a
// fresh process to take effect (there is no in-place hot reload for the
// server skeleton). We are honest about this rather than pretending.
func (i *instance) reload(ctx context.Context) error {
	if err := i.stop(); err != nil {
		return err
	}
	return i.start(ctx)
}

// loopback returns the running worker's loopback address + credentials, used
// by the P2 poller to read frps's mem stats and /api/clients.
func (i *instance) loopback() (handshake, bool) {
	i.mu.RLock()
	defer i.mu.RUnlock()
	if i.w == nil {
		return handshake{}, false
	}
	return i.w.hs, true
}

func (i *instance) recordError(err error) {
	if err == nil {
		return
	}
	i.mu.Lock()
	i.lastErr = err.Error()
	i.mu.Unlock()
	i.logger.Warn("instance error", slog.Any("err", err))
	if i.bus != nil {
		i.bus.Publish(eventbus.TypeInstanceError, i.id, eventbus.InstanceErrorData{Message: err.Error()})
	}
}

// idFromPath derives a config id from a file path. The id is the file
// name without its extension.
func idFromPath(path string) string {
	return util.FileNameWithoutExt(filepath.Base(path))
}

func stateString(s consts.ConfigState) string {
	switch s {
	case consts.ConfigStateStarted:
		return "started"
	case consts.ConfigStateStopped:
		return "stopped"
	case consts.ConfigStateStarting:
		return "starting"
	case consts.ConfigStateStopping:
		return "stopping"
	default:
		return "unknown"
	}
}
