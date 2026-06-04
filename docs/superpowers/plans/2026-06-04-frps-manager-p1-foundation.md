# FRPS 管理器 P1（地基）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把项目从「内嵌 frpc 客户端管理器」改造为「内嵌 frps 服务端管理器」的可运行地基——能编辑 N 份 frps 配置、以子进程方式同时启停 1~N 个 frps、看状态与日志。

**Architecture:** daemon（父进程）通过 re-exec 自身为隐藏子命令 `frpmgrd frps-worker` 跑每个 frps；每个 worker 内嵌 `github.com/fatedier/frp/server`，把 `webServer` 强制绑 loopback 随机端口并把端口/账密握手回报父进程。on-disk 配置是纯 frp 原生 `ServerConfig` TOML；管理器元数据（显示名、手动启动）存 `meta.json`，不污染 toml。

**Tech Stack:** Go 1.25、`github.com/fatedier/frp/server` + `pkg/config`（v0.69.1）、`github.com/pelletier/go-toml/v2`、chi、现有 eventbus/logtail/sysinfo 底座。

**Scope:** 仅 P1 地基（后端 + 最小可用前端配置页）。运行时监控（mem 采样、客户端/隧道/流量）= P2；历史曲线与告警 = P3，各自独立计划。

**关键设计决策（来自设计文档 spec）:**
- 运行模型：N 份配置可同时运行，子进程隔离（因 `mem.StatsCollector` 是进程级全局单例）。
- `reload = stop + start`（frps 服务端参数变更本质需重启）。
- 彻底删除 frpc 专属代码：`services/client.go`、`internal/conntrack`、`internal/api/nathole.go`、`internal/api/proxies.go`、`pkg/config` 的 `ClientConfig*`/INI 遗留/proxies/visitors/store/range、前端 ToolsNat。
- 不对外暴露任何 worker 的 frps 原生 dashboard（仅 loopback）。

---

## 文件结构（创建/修改/删除总览）

**创建：**
- `pkg/config/server.go` — `ServerConfigV1` 模型 + TOML 解析/序列化
- `pkg/config/server_test.go` — 模型往返测试
- `cmd/frpmgrd/frps_worker.go` — `frps-worker` 子命令（子进程内嵌 frps）
- `internal/manager/worker.go` — 父进程侧 worker 监管（spawn/握手/stop）
- `internal/manager/worker_test.go` — 握手解析测试
- `services/frps.go` — frps 服务封装（NewService/Run/Close + 强制 loopback webServer）

**修改：**
- `cmd/frpmgrd/main.go` — 注册 `frps-worker` 子命令；usage 文案改 frps
- `internal/manager/manager.go` — CRUD 改吃 `ServerConfigV1`；name/manualStart 走 meta；删除 MigratePaths/Store/range 相关
- `internal/manager/instance.go` — `svc *FrpClientService` → 子进程 worker；删除 proxyStats/conntrack/parseLocalPorts
- `internal/manager/meta.go`（或同名 metaStore 文件）— 增加 per-id `Name`/`ManualStart` 存取
- `internal/api/server.go` — 删 proxies/nathole 路由；configs/lifecycle 保留
- `internal/api/configs.go` — 解析/响应改 `ServerConfigV1`
- `internal/api/validate.go` — 校验 `ServerConfig`
- `internal/appcfg/appcfg.go` — 文案/默认值微调（保留 ProfilesDir 名）
- `pkg/version/version.go` — usage 文案（如有 frpc 字样）
- `web/src/pages/`（最小前端）— `Configs.tsx` 重建为 frps 配置表单（最小可用）

**删除：**
- `services/client.go`、`services/instance_context.go`（若仅 frpc 用）
- `internal/conntrack/`（整目录）
- `internal/api/nathole.go`、`internal/api/proxies.go`
- `pkg/config/client.go`、`pkg/config/conversion.go`、`pkg/config/v1.go` 中 frpc 专属类型（重写为 server 版）
- `web/src/pages/ToolsNat.tsx`

---

## Task 1: ServerConfigV1 配置模型 + TOML 解析/序列化

**Files:**
- Create: `pkg/config/server.go`
- Test: `pkg/config/server_test.go`

实现要点：on-disk 是纯 frp 原生 `v1.ServerConfig` TOML；`ServerConfigV1` 仅为 API 层 JSON 包装。解析用 `frpconfig.LoadConfigure(b, &sc, false)`，序列化用 `gotoml.Marshal`。管理器元数据不进 toml。

- [ ] **Step 1: 写失败测试**

```go
// pkg/config/server_test.go
package config

import (
	"strings"
	"testing"
)

func TestParseServerTOML_MinimalBindPort(t *testing.T) {
	in := []byte("bindPort = 7000\n")
	sc, err := ParseServerTOML(in)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if sc.BindPort != 7000 {
		t.Fatalf("BindPort = %d, want 7000", sc.BindPort)
	}
}

func TestServerTOML_RoundTrip(t *testing.T) {
	in := []byte("bindPort = 7000\nvhostHTTPPort = 8080\n")
	sc, err := ParseServerTOML(in)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	out, err := sc.MarshalTOML()
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(out), "7000") || !strings.Contains(string(out), "8080") {
		t.Fatalf("round-trip lost fields:\n%s", out)
	}
	// re-parse to confirm validity
	if _, err := ParseServerTOML(out); err != nil {
		t.Fatalf("re-parse: %v", err)
	}
}
```

- [ ] **Step 2: 运行确认失败**

Run: `go test ./pkg/config/ -run TestServerTOML -v`
Expected: FAIL（`ParseServerTOML` / `MarshalTOML` 未定义，编译错误）

- [ ] **Step 3: 写最小实现**

```go
// pkg/config/server.go
package config

import (
	frpconfig "github.com/fatedier/frp/pkg/config"
	v1 "github.com/fatedier/frp/pkg/config/v1"
	gotoml "github.com/pelletier/go-toml/v2"
)

// ServerConfigV1 是 frps 服务端配置的 API 层包装。内嵌上游 v1.ServerConfig
// （bindPort/vhost*/auth/transport/webServer/log/sshTunnelGateway/allowPorts 等，
// 全部 camelCase）。管理器元数据（显示名、手动启动）不在此结构里，存 meta.json。
type ServerConfigV1 struct {
	v1.ServerConfig
}

// ParseServerTOML 解析 frp 原生 server TOML 字节为 ServerConfigV1。
// strict=false：容忍未知字段，避免上游新增 key 导致硬失败。
func ParseServerTOML(b []byte) (*ServerConfigV1, error) {
	sc := &ServerConfigV1{}
	if err := frpconfig.LoadConfigure(b, &sc.ServerConfig, false); err != nil {
		return nil, err
	}
	return sc, nil
}

// MarshalTOML 把 ServerConfigV1 序列化为 frp 原生 server TOML。
func (s *ServerConfigV1) MarshalTOML() ([]byte, error) {
	return gotoml.Marshal(&s.ServerConfig)
}

// Complete 填充上游默认值（bindAddr、heartbeatTimeout 等依赖逻辑）。
// 在写盘/校验前调用，保证回读字段稳定。
func (s *ServerConfigV1) Complete() {
	s.ServerConfig.Complete()
}
```

- [ ] **Step 4: 运行确认通过**

Run: `go test ./pkg/config/ -run TestServerTOML -v`
Expected: PASS

注意：若 `frpconfig.LoadConfigure` 要求 `version` 字段才按 v1 解析，测试里补 `version = "1"` 行；实现期以 `go test` 实际结果为准（`LoadConfigure` 对裸 TOML 默认按 v1 结构反序列化，通常无需 version）。

- [ ] **Step 5: 提交**

```bash
git add pkg/config/server.go pkg/config/server_test.go
git commit -m "feat(config): 新增 ServerConfigV1 模型与 frps TOML 解析/序列化"
```

---

## Task 2: frps 服务封装（services/frps.go）

**Files:**
- Create: `services/frps.go`

镜像 `services/client.go` 的 `FrpClientService`，但用 `server.NewService`。**关键**：构造时把 `webServer` 强制改写为 `127.0.0.1` + 传入端口（0=随机）+ 传入随机账密，使 frps 自己调用一次 `EnableMem()`（避免我们重复调导致流量翻倍），并给父进程一个 loopback 数据通道。

- [ ] **Step 1: 写实现（无独立单测，由 worker 集成验证）**

```go
// services/frps.go
package services

import (
	"context"

	frpserver "github.com/fatedier/frp/server"
	v1 "github.com/fatedier/frp/pkg/config/v1"
	"github.com/fatedier/frp/pkg/util/log"
)

// FrpServerService 内嵌单个 frps 服务端实例。生命周期与 FrpClientService 对称：
// Run(ctx) 阻塞、Close() 优雅关闭。webServer 已在构造前被强制绑 loopback。
type FrpServerService struct {
	svr *frpserver.Service
}

// NewFrpServerService 用已 Complete 的 ServerConfig 构造 frps 服务。
// 调用方（worker）负责在传入前把 cfg.WebServer 改写为 loopback。
func NewFrpServerService(cfg *v1.ServerConfig) (*FrpServerService, error) {
	svr, err := frpserver.NewService(cfg)
	if err != nil {
		return nil, err
	}
	return &FrpServerService{svr: svr}, nil
}

// Run 阻塞运行 frps，直到 ctx 取消。
func (s *FrpServerService) Run(ctx context.Context) {
	log.Infof("start frps service")
	defer log.Infof("frps service stopped")
	s.svr.Run(ctx)
}

// Close 关闭所有监听并停止服务。
func (s *FrpServerService) Close() error {
	return s.svr.Close()
}
```

- [ ] **Step 2: 编译确认**

Run: `go build ./services/`
Expected: 成功（确认 `frpserver.NewService`/`Run`/`Close` 签名与 v0.69.1 一致；若 `Run` 返回 error 则改为 `if err := s.svr.Run(ctx); err != nil { log.Errorf(...) }`，以 `go build` 报错为准）

- [ ] **Step 3: 提交**

```bash
git add services/frps.go
git commit -m "feat(services): 新增内嵌 frps 服务封装 FrpServerService"
```

---

## Task 3: frps-worker 子命令（子进程）

**Files:**
- Create: `cmd/frpmgrd/frps_worker.go`
- Modify: `cmd/frpmgrd/main.go:28-41`（注册子命令）

worker 子进程：读 `--config` → 解析 ServerConfig → 强制 webServer=`127.0.0.1:<port>`+随机账密 → 打印握手首行到 stdout → 运行 frps 直到收到 SIGTERM/stdin 关闭。

握手格式（stdout 首行，父进程解析）：`FRPS_WORKER_READY addr=127.0.0.1:NNNNN user=U pass=P`

- [ ] **Step 1: 注册子命令**

修改 `cmd/frpmgrd/main.go` 的 switch（在 `case "serve":` 后加）：

```go
	case "frps-worker":
		os.Exit(runFrpsWorker(os.Args[2:]))
```

- [ ] **Step 2: 写 worker 实现**

```go
// cmd/frpmgrd/frps_worker.go
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	frpconfig "github.com/fatedier/frp/pkg/config"
)

// runFrpsWorker 是隐藏子命令：在独立进程内跑恰好一个 frps。
// 父进程通过 re-exec 自身 + --config 启动它。webServer 被强制绑 loopback，
// 端口与随机账密通过 stdout 首行握手回报父进程。
func runFrpsWorker(args []string) int {
	fs := flag.NewFlagSet("frps-worker", flag.ExitOnError)
	cfgPath := fs.String("config", "", "path to frps server TOML")
	_ = fs.Parse(args)
	if *cfgPath == "" {
		fmt.Fprintln(os.Stderr, "frps-worker: --config required")
		return 2
	}

	sc, _, err := frpconfig.LoadServerConfig(*cfgPath, false)
	if err != nil {
		fmt.Fprintf(os.Stderr, "frps-worker: load config: %v\n", err)
		return 1
	}

	// 强制 webServer 绑 loopback + 随机端口 + 随机账密。
	// 这样 frps 自己会调用一次 EnableMem()，父进程也能走 loopback 取 client 明细。
	user := randToken(6)
	pass := randToken(16)
	sc.WebServer.Addr = "127.0.0.1"
	sc.WebServer.Port = 0 // 让 OS 选空闲端口；实际端口在 Run 后从 frps 暴露——见 Step 3 注意
	sc.WebServer.User = user
	sc.WebServer.Password = pass
	sc.Complete()

	// 注意：frps 的 WebServer.Port=0 行为需实现期确认是否真的绑随机端口并可回读。
	// 若 frps 不支持 0 端口回读实际端口，改为父进程预分配空闲端口后通过 --webport 传入。
	// 见 worker_test 与 Task 4 的端口策略说明。

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	svc, err := frpserver_NewService(sc)
	if err != nil {
		fmt.Fprintf(os.Stderr, "frps-worker: new service: %v\n", err)
		return 1
	}

	// 握手：告诉父进程 loopback 地址与账密。
	fmt.Printf("FRPS_WORKER_READY addr=127.0.0.1:%d user=%s pass=%s\n",
		sc.WebServer.Port, user, pass)
	os.Stdout.Sync()

	svc.Run(ctx) // 阻塞直到 ctx 取消
	_ = svc.Close()
	return 0
}

func randToken(nbytes int) string {
	b := make([]byte, nbytes)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
```

> **端口策略说明（实现期必读）**：frps `WebServer.Port=0` 是否绑随机端口并可回读，**实现期需用一次手动 spike 确认**。若不支持，采用**父进程预分配**：父进程用 `net.Listen("tcp","127.0.0.1:0")` 拿到空闲端口后立即 Close，把端口号通过 `--webport` 传给 worker，worker 设 `sc.WebServer.Port = <webport>`。此时握手行端口已知，二者一致。推荐直接用预分配策略（更确定），Step 2 代码相应改为读取 `--webport` flag。

- [ ] **Step 3: 调整为父进程预分配端口（落实确定性策略）**

把 Step 2 的 `--config` 旁边加 `webport := fs.Int("webport", 0, "loopback webServer port")`，并：
```go
	sc.WebServer.Port = *webport
```
握手行直接用 `*webport`。`frpserver_NewService` 用 Task 2 的 `services.NewFrpServerService`（import 并替换占位名）。

- [ ] **Step 4: 编译确认**

Run: `go build ./cmd/frpmgrd/`
Expected: 成功

- [ ] **Step 5: 提交**

```bash
git add cmd/frpmgrd/frps_worker.go cmd/frpmgrd/main.go
git commit -m "feat(cmd): 新增 frps-worker 隐藏子命令（子进程内嵌单个 frps）"
```

---

## Task 4: 父进程 worker 监管 + 握手解析

**Files:**
- Create: `internal/manager/worker.go`
- Test: `internal/manager/worker_test.go`

父进程侧：分配空闲 loopback 端口 → re-exec 自身 `frps-worker --config <path> --webport <p>` → 读子进程 stdout 首行握手 → 保存 loopback addr/creds → 子进程 stdout/stderr 接管写合并日志 → stop 时发信号并回收。

- [ ] **Step 1: 写握手解析的失败测试**

```go
// internal/manager/worker_test.go
package manager

import "testing"

func TestParseHandshake_OK(t *testing.T) {
	line := "FRPS_WORKER_READY addr=127.0.0.1:54321 user=abc pass=deadbeef"
	hs, ok := parseHandshake(line)
	if !ok {
		t.Fatal("expected ok")
	}
	if hs.Addr != "127.0.0.1:54321" || hs.User != "abc" || hs.Pass != "deadbeef" {
		t.Fatalf("got %+v", hs)
	}
}

func TestParseHandshake_Reject(t *testing.T) {
	if _, ok := parseHandshake("some random frps log line"); ok {
		t.Fatal("expected reject")
	}
}
```

- [ ] **Step 2: 运行确认失败**

Run: `go test ./internal/manager/ -run TestParseHandshake -v`
Expected: FAIL（`parseHandshake`/`handshake` 未定义）

- [ ] **Step 3: 写实现**

```go
// internal/manager/worker.go
package manager

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// handshake 是 worker 子进程握手首行解析结果。
type handshake struct {
	Addr string // 127.0.0.1:<port>
	User string
	Pass string
}

// parseHandshake 解析 "FRPS_WORKER_READY addr=.. user=.. pass=.." 首行。
func parseHandshake(line string) (handshake, bool) {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "FRPS_WORKER_READY ") {
		return handshake{}, false
	}
	hs := handshake{}
	for _, kv := range strings.Fields(strings.TrimPrefix(line, "FRPS_WORKER_READY ")) {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		switch k {
		case "addr":
			hs.Addr = v
		case "user":
			hs.User = v
		case "pass":
			hs.Pass = v
		}
	}
	if hs.Addr == "" {
		return handshake{}, false
	}
	return hs, true
}

// worker 监管一个 frps 子进程。
type worker struct {
	id      string
	cmd     *exec.Cmd
	hs      handshake
	mu      sync.Mutex
	stopped bool
}

// freeLoopbackPort 预分配一个空闲 loopback 端口（立即释放，交给 worker 绑定）。
func freeLoopbackPort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// spawnWorker re-exec 当前二进制为 frps-worker，等待握手就绪。
// logSink 接管子进程 stdout（握手后剩余行）与 stderr，写入合并日志。
func spawnWorker(ctx context.Context, id, selfExe, cfgPath string, logSink io.Writer) (*worker, error) {
	port, err := freeLoopbackPort()
	if err != nil {
		return nil, fmt.Errorf("alloc loopback port: %w", err)
	}
	cmd := exec.CommandContext(ctx, selfExe,
		"frps-worker", "--config", cfgPath, "--webport", fmt.Sprintf("%d", port))
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = logSink
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start worker: %w", err)
	}

	w := &worker{id: id, cmd: cmd}
	hsCh := make(chan handshake, 1)
	go func() {
		br := bufio.NewReader(stdout)
		// 第一行：握手；之后所有行转发给 logSink。
		first, _ := br.ReadString('\n')
		if hs, ok := parseHandshake(first); ok {
			hsCh <- hs
		} else {
			close(hsCh) // 没握手成功
		}
		_, _ = io.Copy(logSink, br)
	}()

	select {
	case hs, ok := <-hsCh:
		if !ok {
			_ = cmd.Process.Kill()
			return nil, errors.New("worker did not handshake")
		}
		w.hs = hs
		return w, nil
	case <-time.After(10 * time.Second):
		_ = cmd.Process.Kill()
		return nil, errors.New("worker handshake timeout")
	}
}

// stop 优雅终止子进程（SIGTERM via ctx cancel 已由 CommandContext 处理；
// 这里额外等待回收，避免僵尸）。跨平台：Windows 下 CommandContext 取消会 Kill。
func (w *worker) stop() error {
	w.mu.Lock()
	if w.stopped {
		w.mu.Unlock()
		return nil
	}
	w.stopped = true
	w.mu.Unlock()
	if w.cmd.Process != nil {
		// 优先尝试优雅信号（非 Windows）；失败则交给 ctx/Wait。
		_ = signalTerminate(w.cmd.Process)
	}
	_ = w.cmd.Wait()
	return nil
}

// selfExe 返回当前可执行文件路径，用于 re-exec。
func selfExe() (string, error) { return os.Executable() }
```

补充跨平台信号文件（Windows 无 SIGTERM）：

```go
// internal/manager/worker_signal_unix.go
//go:build !windows
package manager
import ("os"; "syscall")
func signalTerminate(p *os.Process) error { return p.Signal(syscall.SIGTERM) }
```
```go
// internal/manager/worker_signal_windows.go
//go:build windows
package manager
import "os"
// Windows 无 SIGTERM；交给 CommandContext 的 ctx 取消（Kill）+ Wait 回收。
func signalTerminate(p *os.Process) error { return p.Kill() }
```

- [ ] **Step 4: 运行确认通过**

Run: `go test ./internal/manager/ -run TestParseHandshake -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add internal/manager/worker.go internal/manager/worker_test.go internal/manager/worker_signal_unix.go internal/manager/worker_signal_windows.go
git commit -m "feat(manager): 父进程 worker 监管 + 握手解析（子进程 frps）"
```

---

## Task 5: instance 改为子进程 worker 模型

**Files:**
- Modify: `internal/manager/instance.go`（重写运行时字段与 start/stop/reload）

把 `svc *services.FrpClientService` + statusPoller + proxyStats + conntrack 全部移除，替换为 `w *worker`。`reload = stop + start`。Snapshot 去掉 proxies（P2 再加运行时 proxy）。

- [ ] **Step 1: 改 instance 结构与运行时字段**

把 `instance` 结构（instance.go:25-51）替换为：

```go
type instance struct {
	id   string
	path string

	mu      sync.RWMutex
	state   consts.ConfigState
	lastErr string
	startAt time.Time
	stopAt  time.Time

	w      *worker
	cancel context.CancelFunc

	logger  *slog.Logger
	bus     *eventbus.Bus
	selfExe string
	logSink io.Writer
}
```

删除：`data *config.ClientConfig`（改由 manager + meta 持有 server 配置）、`proxyStats`/`connsByName`/`psMu`/`runWG`/`autoDel`（autoDelete 本期不迁移）。`newInstance` 相应简化（去掉 proxyStats 初始化）。

- [ ] **Step 2: 重写 start/stop/reload**

```go
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

	// 监视子进程退出（崩溃/自退）→ 同步状态
	go func() {
		_ = w.cmd.Wait()
		i.mu.Lock()
		wasStopping := i.state == consts.ConfigStateStopping
		i.w = nil
		i.mu.Unlock()
		if !wasStopping {
			i.setState(consts.ConfigStateStopped)
			i.logger.Info("frps worker exited")
		}
	}()

	i.setState(consts.ConfigStateStarted)
	i.logger.Info("frps instance started", slog.String("loopback", w.hs.Addr))
	return nil
}

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

// reload 对 frps = 重启（服务端参数变更需重启生效）。
func (i *instance) reload(ctx context.Context) error {
	if err := i.stop(); err != nil {
		return err
	}
	return i.start(ctx)
}

// loopback 返回当前运行 worker 的 loopback 地址与账密（P2 采样用）。
func (i *instance) loopback() (handshake, bool) {
	i.mu.RLock()
	defer i.mu.RUnlock()
	if i.w == nil {
		return handshake{}, false
	}
	return i.w.hs, true
}
```

删除 instance.go 里：`runLoop`、`statusPoller`、`refreshConnCounts`、`refreshProxyStats`、`proxySnapshots`、`parseLocalPorts` 及其辅助（`splitOn/trimSpace/indexOf/atoiU16`）、`clearProxyStats`、`scheduleAutoDelete`/`cancelAutoDelete`、`proxyStatusChanged`、`instanceCtx`。`Snapshot` 去掉 `includeProxies`/`Proxies` 字段（保留 ID/Name/State/Error/时间）。`Data()` 删除（配置改由 manager 提供）。

- [ ] **Step 3: 编译（manager 包暂会因 manager.go 未改而报错，预期）**

Run: `go build ./internal/manager/ 2>&1 | head`
Expected: 报错集中在 manager.go 对已删方法/字段的引用——Task 6 修复。

- [ ] **Step 4: 提交（与 Task 6 合并提交亦可）**

暂不提交，待 Task 6 一起编译通过后提交。

---

## Task 6: Manager CRUD 改吃 ServerConfigV1 + meta 存 name/manualStart

**Files:**
- Modify: `internal/manager/manager.go`
- Modify: `internal/manager/`（metaStore 文件，新增 Name/ManualStart 存取）

配置 on-disk 是纯 server TOML；`LoadAll` 用 `os.ReadFile` + `config.ParseServerTOML`；name/manualStart 从 meta 读。删除 `MigratePaths`/`writeConfig` 的 store/log 重写逻辑（frps 日志走 worker stdout 接管，不再依赖 toml 内 log 路径）。

- [ ] **Step 1: metaStore 增加 per-id 元数据存取**

在 metaStore 结构的持久化 JSON 里增加 `Names map[string]string` 与 `Manual map[string]bool`，并加方法：

```go
func (m *metaStore) name(id string) string { /* 读 Names[id] */ }
func (m *metaStore) setName(id, name string) error { /* 写 + persist */ }
func (m *metaStore) manualStart(id string) bool { /* 读 Manual[id] */ }
func (m *metaStore) setManualStart(id string, v bool) error { /* 写 + persist */ }
func (m *metaStore) dropMeta(id string) { /* 删 Names[id]/Manual[id]（在 dropIDs 内一并调用） */ }
```

（按现有 metaStore 的 mutex + persist 模式实现；参照同文件已有的 `setSort`/`logViewSince` 写法。）

- [ ] **Step 2: 改写 Manager 的配置类型与 CRUD**

`Manager` 不再持 `config.ClientConfig`。`newInstance` 改签名为 `newInstance(id, path string, logger, bus, selfExe, logSink)`。关键改动：

```go
// LoadAll：扫描 *.toml，仅校验可解析，不再读 frpc 字段
func (m *Manager) LoadAll() error {
	files, _ := filepath.Glob(filepath.Join(m.opts.ProfilesDir, "*.toml"))
	exe, _ := selfExe()
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil { continue }
		if _, err := config.ParseServerTOML(b); err != nil {
			m.opts.Logger.Warn("skip unparseable server config", slog.String("path", f), slog.Any("err", err))
			continue
		}
		id := idFromPath(f)
		inst := newInstance(id, f, m.opts.Logger, m.opts.Bus, exe, m.combinedLogWriter())
		m.mu.Lock(); m.instances[id] = inst; m.mu.Unlock()
	}
	return nil
}

// Create：写纯 server TOML；name/manualStart 入 meta
func (m *Manager) Create(id string, sc *config.ServerConfigV1, name string, manualStart bool) error {
	if err := validateID(id); err != nil { return err }
	if m.Exists(id) { return ErrExists }
	sc.Complete()
	b, err := sc.MarshalTOML()
	if err != nil { return err }
	path := m.pathFor(id)
	if err := writeAtomic(path, b); err != nil { return err }
	_ = m.meta.setName(id, name)
	_ = m.meta.setManualStart(id, manualStart)
	exe, _ := selfExe()
	inst := newInstance(id, path, m.opts.Logger, m.opts.Bus, exe, m.combinedLogWriter())
	m.mu.Lock(); m.instances[id] = inst; m.mu.Unlock()
	cur := m.meta.snapshot().Sort
	if !slices.Contains(cur, id) { _ = m.meta.setSort(append(cur, id)) }
	return nil
}

// Update：整体替换 TOML；运行中则 reload(=重启)
func (m *Manager) Update(id string, sc *config.ServerConfigV1, name string, manualStart bool) error {
	inst := m.get(id)
	if inst == nil { return ErrNotFound }
	sc.Complete()
	b, err := sc.MarshalTOML()
	if err != nil { return err }
	if err := writeAtomic(inst.Path(), b); err != nil { return err }
	_ = m.meta.setName(id, name)
	_ = m.meta.setManualStart(id, manualStart)
	if inst.State() == consts.ConfigStateStarted {
		if err := inst.reload(m.rootCtx); err != nil {
			m.opts.Logger.Warn("reload after update failed", slog.String("id", id), slog.Any("err", err))
		}
	}
	if m.opts.Bus != nil { m.opts.Bus.Publish(eventbus.TypeConfigChanged, id, nil) }
	return nil
}
```

`Get` 改为返回 `(Snapshot, *config.ServerConfigV1, error)`：从磁盘读 TOML 解析；name 注入 Snapshot。`Reload` 改调 `inst.reload(m.rootCtx)`。`ReadRaw` 不变。`WriteRaw` 改用 `config.ParseServerTOML` 做解析校验。`Delete` 增加 `m.meta.dropMeta(id)`。`AutoStart` 的 manualStart 改读 `m.meta.manualStart(id)`。`List`/`Snapshot` 用 `m.meta.name(id)` 注入显示名。

删除：`MigratePaths`、`ArmAllAutoDelete`（若仅 frpc）、`writeConfig`（被 MarshalTOML+writeAtomic 取代）、`CombinedLogPath` 保留（worker 日志接管用），新增 `combinedLogWriter()` 返回写合并日志文件的 `io.Writer`（参照现有 LogsDir+frps.log，可用 `logtail` 配套或简单 `os.OpenFile` append）。

- [ ] **Step 3: 改 main.go 调用点**

`cmd/frpmgrd/main.go:106-107` 删除 `mgr.MigratePaths()` 与 `mgr.ArmAllAutoDelete()`（若已删）。usage 文案 frpc→frps。

- [ ] **Step 4: 编译整个后端**

Run: `go build ./... 2>&1 | head -40`
Expected: 报错只剩 api 层（configs/proxies/validate handler 未改）——Task 7/8 修复。

- [ ] **Step 5: 提交**

```bash
git add internal/manager/ cmd/frpmgrd/
git commit -m "feat(manager): 切换为 frps 子进程模型，配置改吃 ServerConfigV1，元数据入 meta"
```

---

## Task 7: API configs/lifecycle 改造 + 删除 proxies/nathole 路由

**Files:**
- Modify: `internal/api/server.go`、`internal/api/configs.go`、`internal/api/status.go`、`internal/api/lifecycle.go`
- Delete: `internal/api/proxies.go`、`internal/api/nathole.go`

- [ ] **Step 1: 删路由**

`internal/api/server.go`：删除 `proxies := NewProxiesHandler(...)`、`nat := NewNatholeHandler()` 及对应 7 条路由（71-76、99 行）。删除 `services/client.go`、`internal/conntrack` 的 import 链一并清理（编译会提示）。

- [ ] **Step 2: 改 configs handler 的请求/响应类型**

`internal/api/configs.go`：把 `*config.ClientConfig`/`ClientConfigV1` 全部换为 `*config.ServerConfigV1`。`Create`/`Update` 请求体解析为 `{ config: ServerConfigV1, frpmgr: { name, manualStart } }`（或顶层平铺，按现有 configs.go 的 decode 风格对齐）。响应 `Get` 返回 `{ ...snapshot, config: ServerConfigV1, frpmgr: {name, manualStart} }`。`decodeJSON` 仍 `DisallowUnknownFields`——确保前端字段与 `v1.ServerConfig` 的 camelCase 完全一致（遵守 web-api-binding skill：动前对核 Go 源字段）。

> 实现期细节以 configs.go 现有 handler 结构为准（List/Create/Get/Update/Patch/Delete/Duplicate/GetRaw/PutRaw）。逐个把底层 Manager 调用换成新签名。

- [ ] **Step 3: lifecycle/status 适配**

`internal/api/lifecycle.go` 的 `Reload` 仍调 `m.Reload(id)`（内部已变重启语义）。`internal/api/status.go` 的 `Get` 去掉 `includeProxies`（Snapshot 不再有 proxies；P2 另开 runtime 端点）。

- [ ] **Step 4: 编译**

Run: `go build ./... 2>&1 | head -40`
Expected: 报错只剩 validate handler——Task 8 修复。

- [ ] **Step 5: 提交**

```bash
git rm internal/api/proxies.go internal/api/nathole.go
git add internal/api/
git commit -m "feat(api): configs/lifecycle 改吃 ServerConfigV1，删除 proxies/nathole 端点"
```

---

## Task 8: validate handler 校验 ServerConfig

**Files:**
- Modify: `internal/api/validate.go`

- [ ] **Step 1: 改 validate 实现**

把校验逻辑换为：接受 JSON 或 TOML body → 解析为 `config.ServerConfigV1` → `sc.Complete()` → 调用上游 `serverValidation.ValidateServerConfig(&sc.ServerConfig)`（import `github.com/fatedier/frp/pkg/config/v1/validation`；实现期确认函数名，client 侧用的是 `ValidateAllClientConfig`，server 侧对应 `ValidateServerConfig`）。返回 `{ valid: bool, errors: [...] }`，对齐现有 validate.go 响应结构。

- [ ] **Step 2: 编译全绿**

Run: `go build ./... 2>&1 | head`
Expected: 成功（无报错）

- [ ] **Step 3: vet + test**

Run: `go vet ./...` 然后 `go test ./...`
Expected: 全绿（Task 1/4 的单测通过；其余包至少编译通过）

- [ ] **Step 4: 提交**

```bash
git add internal/api/validate.go
git commit -m "feat(api): validate 改为校验 frps ServerConfig"
```

---

## Task 9: 清理 frpc 残留 + 删除目录

**Files:**
- Delete: `services/client.go`、`services/instance_context.go`（确认无引用后）、`internal/conntrack/`（整目录）、`pkg/config/client.go`、`pkg/config/conversion.go`、`pkg/config/v1.go` 的 frpc 类型
- Modify: `pkg/config/` 保留 server 相关；`pkg/consts` 删 frpc 专属常量（按编译提示）

- [ ] **Step 1: 逐个删除并编译**

```bash
git rm services/client.go internal/conntrack/*.go pkg/config/v1.go pkg/config/conversion.go pkg/config/client.go
go build ./... 2>&1 | head -40
```
按报错补删/补改残留引用（`consts.ProxyType*`、`RangePort`、`AutoDelete` 等 frpc 专属符号）。`pkg/config/v1.go` 若仍含 server 需要的辅助，先拆出再删。

- [ ] **Step 2: 全绿验证**

Run: `go build ./... && go vet ./... && go test ./...`
Expected: 全部成功

- [ ] **Step 3: 提交**

```bash
git add -A
git commit -m "chore: 彻底删除 frpc 客户端管理残留代码"
```

---

## Task 10: 端到端冒烟（手动验证子进程能跑起 frps）

**Files:** 无（手动验证）

- [ ] **Step 1: 构建**

Run: `make build-host`
Expected: 生成 `bin/frpmgrd`，无错

- [ ] **Step 2: 起 daemon**

Run: `FRPMGR_API_TOKEN=dev FRPMGR_DATA_DIR=./tmp/data ./bin/frpmgrd serve`
Expected: 监听 :8080，无崩溃

- [ ] **Step 3: 创建并启动一个 frps 配置（另开终端）**

```bash
curl -s -H "Authorization: Bearer dev" -H "Content-Type: application/json" \
  -X POST http://127.0.0.1:8080/api/v1/configs \
  -d '{"id":"main","config":{"bindPort":7000},"frpmgr":{"name":"主服务端"}}'
curl -s -H "Authorization: Bearer dev" -X POST http://127.0.0.1:8080/api/v1/configs/main/start
curl -s -H "Authorization: Bearer dev" http://127.0.0.1:8080/api/v1/configs/main/status
```
Expected: status 返回 `state: "started"`；`ss -ltnp | grep 7000` 能看到子进程在监听 7000；daemon 日志出现 worker 握手 loopback 地址。

- [ ] **Step 4: 真 frpc 连接验证（可选但推荐）**

用一个真实 frpc（`serverPort=7000` + 同 token）连上，确认 frps 子进程接受连接、daemon 不崩。停止：`POST /configs/main/stop` → 7000 端口释放、子进程消失。

- [ ] **Step 5: 提交冒烟记录（可选）**

无代码变更；若调通过程中修了 bug，单独提交。

---

## Task 11: 最小可用前端（frps 配置表单）

**Files:**
- Modify: `web/src/pages/Configs.tsx`（重建为 frps 配置）
- Modify: `web/src/api/`（gen:api 重生成 schema）
- Delete: `web/src/pages/ToolsNat.tsx` + 其路由

> 遵守项目第一大坑：动任何 `/api/v1` 绑定前激活 `web-api-binding` skill，对核 `v1.ServerConfig` 的 camelCase 字段。本任务**只做最小可用**：基础字段表单（bindAddr/bindPort/vhostHTTPPort/vhostHTTPSPort/auth.method/auth.token/log.level）+ 原始 TOML 双向编辑 + start/stop/reload 按钮 + 配置列表。完整全参数分组表单留待前端专项计划。

- [ ] **Step 1: 重生成 API schema**

先同步 `internal/api/openapi.yaml`（configs 请求/响应改 ServerConfigV1，删 proxies/nathole path），然后：
Run: `cd web && npm run gen:api`
Expected: `src/api/schema.d.ts` 更新，无报错

- [ ] **Step 2: 重写 Configs 页（最小表单）**

把 Configs.tsx 的 proxies/visitors 相关 UI 全部移除，配置表单字段改为上述 frps 基础字段（Ant Design Form，字段 name 用 camelCase 对应 `v1.ServerConfig`）。保留：列表、新建/编辑、start/stop/reload、原始 TOML（CodeMirror）双编辑。请求体 `{ id, config: {...camelCase...}, frpmgr: { name, manualStart } }`。

- [ ] **Step 3: 删 ToolsNat 路由与页面**

从 `web/src/components/MainLayout.tsx`（菜单）与路由表移除 `/tools/nat`，删除 `ToolsNat.tsx`。

- [ ] **Step 4: 前端类型检查 + 构建**

Run: `cd web && npx tsc -b && npm run build`
Expected: 全绿

- [ ] **Step 5: 端到端联调**

`make build-host` 后起 daemon，浏览器开 `http://localhost:8080`，用 token `dev` 登录，新建一个 `bindPort=7000` 的配置，启动，确认状态变 started、7000 端口被子进程监听。

- [ ] **Step 6: 提交**

```bash
git add web/ internal/api/openapi.yaml
git commit -m "feat(web): Configs 页重建为 frps 配置（最小可用），删除 NAT 工具页"
```

---

## P1 完成标准（验收）

- `make build-host`、`go vet ./...`、`go test ./...`、`cd web && npx tsc -b` 全绿。
- 能通过 UI 创建/编辑/删除 N 份 frps 配置，能**同时启动多份**（不同 bindPort），互不干扰。
- 子进程模型工作：每个运行中的配置对应一个 `frps-worker` 子进程，loopback webServer 仅绑 127.0.0.1。
- 真实 frpc 能连上任一运行中的 frps；stop 后端口释放、子进程回收。
- 仓库内 frpc 客户端管理代码已彻底删除（proxies/visitors/conntrack/nathole/client.go）。
- 文档同步：`openapi.yaml` 与实际 configs/lifecycle API 一致。

## 后续计划（不在本计划内）

- **P2**：父进程 poller 经 worker loopback 读 `mem.StatsCollector`（serverinfo/proxy/traffic）+ `/api/clients`；新增 `/runtime/{id}/*` 端点；前端 Runtime 监控页；新增 WS 事件类型。
- **P3**：采样落 SQLite（modernc.org/sqlite）；`/metrics/{id}/traffic` 曲线 + 页面；告警引擎 + `/alerts` + 页面 + webhook。
- **前端专项**：frps 全参数分组表单（auth/transport/webServer/log/vhost/ssh 网关/allowPorts）替代最小表单。

---

## 复审修正（2026-06-04，执行前二次核验）

逐条核对「实现期确认」项与现有代码引用，证据均来自 `frp@v0.69.1` 源码与本仓现有代码。以下修正在执行时**优先于正文**。

### R1. 【Task 3】webServer 端口：删掉 Port=0 写法，统一用预分配非零端口

`server/service.go:146` 证实 **Port=0 时 frps 不起 webServer**（无监听/无 mem/无 /api/clients）。Task 3 Step 2 里 `sc.WebServer.Port = 0` 与握手行打印 `sc.WebServer.Port`（=0）**作废**。最终实现 = Step 3：父进程 `net.Listen("127.0.0.1:0")` 取空闲端口→Close→`--webport <非零>` 传给 worker→worker `sc.WebServer.Port = *webport`→握手行打印 `*webport`。**Step 2 代码仅演示，一切以 Step 3 为准。**

### R2. 【Task 1/Task 2】Complete() 返回 error

`(*v1.ServerConfig).Complete() error`。Task 1 的包装改为：
```go
func (s *ServerConfigV1) Complete() error { return s.ServerConfig.Complete() }
```
所有调用点（Create/Update/worker/validate）处理返回的 error。

### R3. 【Task 8】ValidateServerConfig 是方法不是包级函数

正确形态：`(*validation.ConfigValidator).ValidateServerConfig(&sc.ServerConfig) (Warning, error)`。validate handler 须先构造 `ConfigValidator`（构造方式以 `go build` 为准——零值可用或有 New 函数）。现有 `config.UnmarshalClientConf` 调用点同步替换。

### R4. 【Task 2】删除「镜像 client.go 的 Close()」表述

现有 `FrpClientService` 是 `Stop(wait bool)`，**无 Close()**。frps 的 `server.Service` 才有 `Close() error`。`FrpServerService.Close()` 直接包 `svr.Close()`，与 client 封装无对称关系。

### R5. 【Task 6】meta.json 向后兼容（新增 map 字段必须 nil-init）

现有 `Meta` 仅 `Version/AutoStart/Sort/LogViewSince`。新增 `Names map[string]string`、`Manual map[string]bool` 后，`openMetaStore` 读盘处必须：
```go
if m.Names == nil { m.Names = map[string]string{} }
if m.Manual == nil { m.Manual = map[string]bool{} }
```
否则旧 meta.json 读出 nil map，写入 panic / 静默丢数据。`dropIDs` 内补删 `Names[id]`/`Manual[id]`。

### R6. 【决策】AutoDelete：P1 直接删除（消除计划内自相矛盾）

现有 `AutoDelete`（`pkg/config/conf.go` + `instance.scheduleAutoDelete/cancelAutoDelete` + `manager.ArmAllAutoDelete` + `main.go:107`）是 frpc 时代「定时自删配置」特性，与 frps 骨架管理无关。**决策：P1 一并删除，不迁移**。涉及：instance 去 `autoDel`/`scheduleAutoDelete`/`cancelAutoDelete`；manager 去 `ArmAllAutoDelete`；main.go:107 删调用；consts/conf 去 `AutoDelete` 符号。如未来需要，归 P3 另设。

### R7. 现有引用核实结论（计划准确性）

- ✅ 行号全对：server.go:71-76（proxies）、:99（nathole）、:46（NewProxiesHandler）、:53（NewNatholeHandler）、main.go:106-107（MigratePaths/ArmAllAutoDelete）。
- ✅ instance 结构 25-51；现有 `newInstance(id, path, data *config.ClientConfig, logger, bus)`；Snapshot 含 `Proxies []ProxySnapshot`（Task 5 移除）。
- ✅ validate.go 现调 `config.UnmarshalClientConf`（Task 8 替换）。
- ✅ `LoadServerConfig(path, strict) (*v1.ServerConfig, bool, error)`（3 返回值）、`LoadConfigure(b, c, strict, ...formats) error` 签名属实。

### R8. 执行顺序微调（降级联风险）

Task 6 是类型级联爆点（20+ 调用点改签名）。落地顺序：**1→2→3→4**（地基，可独立编译+测试通过并各自提交）→ **5+6 作为一个原子改动**（一起编过再提交，因互相依赖类型）→ **7→8→9**。Task 9 删 2000+ 行，务必 `go build ./...` 逐步验证无悬空 import。
