# 设计文档：将项目彻底改造为 FRPS 管理器

- 日期：2026-06-04
- 状态：待用户复审
- 范围：把现有「无头 frpc 客户端管理器」彻底重建为「无头 frps 服务端管理器」

---

## 1. 背景与目标

现有项目是一个内嵌 `github.com/fatedier/frp/client` 的 **frpc 客户端管理器**：每份配置 = 一个 frpc 实例 = 「服务器地址 + 认证 + 一组静态 proxies/visitors」，多实例并行、可增删改启停、隧道写死在 toml 里。

本次目标：**彻底替换**为 **frps 服务端管理器**。核心定位（用户已确认）：

- 管理 **N 份 frps 服务端配置档案**，支持 **1~N 份同时运行**。
- 提供 **实时客户端/隧道/流量监控**（frps 的 proxy 由客户端运行时注册，不是配置出来的，所以只读观测）。
- 提供 **历史流量曲线 + 告警**。
- 提供 **frps 全部参数的可视化编辑**（含原始 TOML 双向编辑）。
- 保持 **单二进制交付**、内嵌 frp 库、复用现有鉴权/事件/系统监控底座。

**不做**（YAGNI，用户已排除）：端口白名单/用户配额的高级管理（仅作为普通参数编辑覆盖，不做专门的配额治理子系统）。

### 1.1 概念错配（本设计的根因）

frpc 与 frps 是两种语义，照搬会从地基歪掉：

| 维度 | frpc（旧） | frps（新） |
|---|---|---|
| 核心对象 | 静态隧道（proxies/visitors） | 服务端骨架配置（端口/vhost/认证/dashboard） |
| 隧道来源 | 用户在 toml 里配置 | 客户端运行时 `NewProxy` 动态注册 |
| 实例数 | 多实例常态并行 | 单例为常态（同机多实例需不同端口） |
| 管理重心 | 编辑隧道 | 编辑骨架 + 观测动态接入 |

因此：可复用底座，但 **Configs/Proxies（最复杂的核心页）必须重建**，proxy 从「可写 CRUD」降级为「只读运行时监控」。

---

## 2. 关键技术结论（源码 spike 已验证，v0.69.1）

证据来自本地 module 缓存源码精读，非推测：

1. **内嵌对称性**：`server.NewService(cfg *v1.ServerConfig) (*Service, error)`，`(*Service).Run(ctx)` 阻塞、`(*Service).Close() error`，与现有 `client.Service` 用法完全对称。入参只吃 `*v1.ServerConfig`，**无 proxy 数组**。
2. **运行时 proxy 数据进程内可直读**：全局单例 `mem.StatsCollector`（`pkg/metrics/mem`，包 `init()` 即活），提供 `GetServer()/GetProxiesByType()/GetProxyByName()/GetProxyTraffic()`。
3. **客户端明细列表拿不到（进程内）**：来自私有字段 `svr.clientRegistry`，无导出 getter。只能通过 frps 内置 webServer 的 `GET /api/clients` 取。
4. **流量粒度有限**：mem 只保留**按天 7 桶**，今日值跨午夜归零，**无 all-time 累计、无分钟级、进程重启即丢**。→ 实时曲线/历史/告警**必须我们自己定时采样落库**。
5. **`EnableMem()` 陷阱**：仅当 `webServer.Port>0` 时被 frps 调用，且**非幂等**（重复调流量翻倍）。
6. **进程级全局单例致命点**：同进程跑多个 frps，`mem.StatsCollector` 把所有实例流量混在一起，**无法按实例分离**。

结论 6 直接决定了运行模型（见 §3）。

---

## 3. 运行模型决策：子进程 worker（用户已确认方案 B）

「N 个 frps 同时运行且指标可分离」与「同进程内嵌」不可兼得（因结论 6）。用户选择 **方案 B：子进程 worker**。

- daemon（父进程）**re-exec 自身**为隐藏子命令 `frpmgrd frps-worker`，每个子进程内嵌并运行**恰好一个** frps。
- 每个 worker 是独立进程 → 拥有**独立的** `mem.StatsCollector` → 指标天然按实例隔离；一个 frps 崩溃不拖垮 daemon 与其它 worker。
- 仍是**单二进制**（子进程也是同一个二进制，内嵌 frp 库）。
- 代价：父进程获取运行时数据**全部走每个 worker 的 loopback HTTP**（无进程内快路径），并多出进程监管/握手/子进程日志接管逻辑。

### 3.1 子命令

`cmd/frpmgrd/main.go`：`serve`（父守护进程）| `frps-worker`（子进程，隐藏）| `health` | `version`。

### 3.2 worker 集成细节（规避 §2 的坑）

- worker 启动时，将配置中的 `webServer` **强制覆盖**为 `127.0.0.1:0`（让 OS 选空闲端口）+ **随机 user/password**。因 `webServer.Port>0`，frps 会**自己**正确调用一次 `EnableMem()`——我们**绝不**自己调，避免翻倍。
- worker 把实际绑定的 loopback 端口 + 随机账密，作为**第一行握手信息**打到 stdout，父进程读取后据此轮询。
- frps 的运行日志走 worker 的 stdout/stderr，父进程接管 → 写入合并日志文件 → 复用 `logtail`/`eventbus` 推流。
- 对外**绝不**暴露任何 worker 的 frps 原生面板（仅 loopback）。

### 3.3 生命周期语义

- `start(id)`：spawn worker 子进程 → 等待握手就绪 → 标记 running。
- `stop(id)`：向 worker 发送终止信号（worker 内 `cancel ctx` → `svc.Close()`）→ 回收。
- `reload(id)`：frps 服务端参数变更**本质需重启**才能生效，故 `reload = stop + start`（如实告知用户，不假装热重载）。
- 父进程对每个 running worker 起一个 poller，按固定间隔（默认 10s）轮询其 loopback HTTP 采样。

---

## 4. 后端架构

```
cmd/frpmgrd/main.go
├─ serve（父守护进程）
│   └─ Manager
│        ├─ profiles : map[id]*ServerProfile      // N 份已保存配置档案
│        ├─ workers  : map[id]*worker             // 运行中的子进程（可多个）
│        │     ├─ cmd        : exec(self, "frps-worker", "--config", path)
│        │     ├─ loopback   : 127.0.0.1:<port>   // 来自子进程握手
│        │     ├─ creds      : 随机 user/pass
│        │     ├─ logPump    : 接管子进程 stdout/stderr → 合并日志
│        │     └─ poller     : 每 10s 轮询 loopback → 采样 → 落时序库 → EventBus
│        ├─ MetricsStore  (modernc.org/sqlite)    // 时序：proxy/client/server 维度
│        ├─ AlertEngine                            // 规则评估 → EventBus + 可选 webhook
│        ├─ meta : metaStore                       // 复用：排序、日志清空时间戳等
│        └─ Bus  : EventBus                        // 复用 + 新增事件类型
└─ frps-worker（子进程，隐藏）
     ├─ 读 --config 的 ServerConfig
     ├─ 覆盖 webServer = 127.0.0.1:0 + 随机账密
     ├─ 握手：打印 loopback 端口 + 账密到 stdout 首行
     └─ svc := server.NewService(cfg); go svc.Run(ctx); 阻塞等待
```

父进程从每个 worker 的 loopback 读取：`/api/serverinfo`、`/api/proxy/{type}`、`/api/proxy/{type}/{name}`、`/api/traffic/{name}`、`/api/clients`。

### 4.1 复用模块

- `internal/api`（chi 路由、`Bearer` 鉴权、CORS、Recover、AccessLog）——骨架不动，路由表大改。
- `internal/eventbus`——复用，新增事件类型（见 §5.3）。
- `internal/sysinfo`——服务器机器监控（CPU/内存/磁盘/网络），价值更大，保留。
- `internal/logtail`——frps 日志流，保留。
- `internal/manager` 的 meta/自启动/快照框架——保留并改造。

### 4.2 删除模块

- `internal/conntrack`（/proc/net/tcp per-port 连接数）——mem collector 已提供 per-proxy 连接数，删除。
- `internal/api/nathole.go`（STUN 发现）——客户端语义，删除。
- 全部 frpc 专属：`pkg/config` 的 `ClientConfigV1`/proxies/visitors/store/range、`services/client.go` 等——删除或重建。

---

## 5. 数据模型

### 5.1 配置模型（重建）

```go
// pkg/config：ClientConfigV1 → ServerConfigV1
type ServerConfigV1 struct {
    v1.ServerConfig          // 内嵌上游：bindAddr/bindPort/kcpBindPort/quicBindPort/
                             // vhostHTTP(S)Port/subDomainHost/allowPorts/maxPortsPerClient/
                             // auth/transport/webServer/log/sshTunnelGateway/httpPlugins ...
    Mgr Mgr `json:"frpmgr"`  // 管理器扩展
}

type Mgr struct {
    Name        string `json:"name"`         // 显示名/备注
    ManualStart bool   `json:"manualStart"`  // 是否手动启动
}
```

字段命名遵循上游 v1 的 camelCase（注意不规则大小写：`vhostHTTPPort`、`tcpmuxHTTPConnectPort`、`natholeAnalysisDataReserveHours`、`kcpBindPort` 等）。`version` 必填 `"1"`，否则 frps 按 legacy ini 解析。

**指针类字段需 UI 三态处理**：`detailedErrorsToClient (*bool)`、`transport.tcpMux (*bool)`、`webServer.tls (*TLSConfig)`、`auth.tokenSource (*ValueSource)`——nil/未设 与 显式 false/空 语义不同。

**worker 覆盖**：保存的 `webServer` 是给用户编辑「是否对外开 dashboard」的语义；worker 实际运行时会克隆配置并把 `webServer` 改写为 loopback 随机端口（用户配置的对外 dashboard 若需要，另行处理或本期不暴露——见 §11 未决项）。

### 5.2 运行时快照（只读，snake_case，对齐现有 Snapshot 风格）

```go
type ServerOverview struct {
    CurConns        int64            `json:"cur_conns"`
    ClientCounts    int64            `json:"client_counts"`
    TotalTrafficIn  int64            `json:"total_traffic_in"`   // 今日
    TotalTrafficOut int64            `json:"total_traffic_out"`  // 今日
    ProxyTypeCounts map[string]int64 `json:"proxy_type_counts"`
}

type ProxyRuntime struct {
    Name, Type, User, ClientID string
    CurConns         int64  `json:"cur_conns"`
    TodayTrafficIn   int64  `json:"today_traffic_in"`
    TodayTrafficOut  int64  `json:"today_traffic_out"`
    LastStartTime    string `json:"last_start_time"`
    LastCloseTime    string `json:"last_close_time"`
    Online           bool   `json:"online"`
}

type ClientRuntime struct {  // 来自 loopback GET /api/clients
    RunID      string `json:"run_id"`
    Addr       string `json:"addr"`
    Version    string `json:"version"`
    ConnectAt  string `json:"connect_at"`
    // 字段以 frps /api/clients 实际响应为准（实现期对核）
}
```

### 5.3 时序与告警

```go
type TrafficPoint struct {
    Ts    int64  // 采样秒级时间戳
    InstID string
    Scope string // "server" | "proxy" | "client"
    Key   string // proxy 名 / client run_id / ""(server)
    In    int64  // 区间增量（已处理午夜归零回绕）
    Out   int64
    Conns int64  // 采样瞬时值
}

type AlertRule struct {
    ID, Name string
    Enabled  bool
    InstID   string  // 作用的配置实例（或 "*"）
    Metric   string  // conns | traffic_in_rate | traffic_out_rate | proxy_offline | client_offline
    Op       string  // ">" | ">=" | "<" | "<="
    Threshold float64
    ForSeconds int    // 持续多久才触发（去抖）
    Target   string   // proxy 名 / "*"
    Webhook  string   // 可选
}

type AlertEvent struct {
    ID, RuleID string
    InstID, Target string
    FiredAt, ResolvedAt int64
    Value float64
    State string // firing | resolved
}
```

**采样器**：父进程 poller 每 10s 读各 worker 的 `GetServer`/`GetProxiesByType`/`GetProxyTraffic`（经 loopback HTTP）+ `/api/clients`，计算区间增量（`max(0, cur-prev)`，跨午夜 `TodayTraffic` 归零时重置 prev），写入 SQLite。曲线查询走 SQL 聚合 + 按 `step` 降采样。

---

## 6. API 设计

基址 `/api/v1`，鉴权（除 `/health`）沿用 Bearer。snake_case 响应沿用现状约定。

### 6.1 保留（行为基本不变，配置语义改为 server）

```
GET  /health
GET  /version
GET  /events                      (WebSocket，新增事件类型)
GET  /system/{info|cpu|memory|disk|network|process}
POST /validate                    校验 ServerConfig（JSON 或 TOML）
POST /import/{file|url|text|zip}  导入 server 配置
GET  /configs/{id}/export
GET  /export/all
```

### 6.2 重建：服务端配置档案

```
GET    /configs                   列出所有 server 配置（含运行状态）
POST   /configs                   创建
POST   /configs/reorder           排序
GET    /configs/{id}              取单个（含完整 ServerConfigV1）
PUT    /configs/{id}              整体替换
PATCH  /configs/{id}              合并
DELETE /configs/{id}
POST   /configs/{id}/duplicate
GET    /configs/{id}/raw          原始 TOML
PUT    /configs/{id}/raw
POST   /configs/{id}/start        spawn worker（支持多个同时运行）
POST   /configs/{id}/stop
POST   /configs/{id}/reload       = stop + start（如实标注）
GET    /configs/{id}/status       运行状态
GET    /configs/{id}/logs         日志查询/分页
DELETE /configs/{id}/logs         清空（设 since 水位）
GET    /configs/{id}/logs/tail    (WebSocket)
GET    /configs/{id}/logs/files
```

### 6.3 新增：运行时监控（只读，带实例维度）

```
GET /runtime/{id}/overview            服务端总览（读 mem，经 worker loopback）
GET /runtime/{id}/proxies             活跃 proxy 列表
GET /runtime/{id}/proxies/{name}      单个 proxy 实时
GET /runtime/{id}/clients             活跃客户端明细（worker loopback /api/clients）
```

### 6.4 新增：历史流量与告警

```
GET    /metrics/{id}/traffic?scope=&key=&from=&to=&step=   历史曲线（读 SQLite）
GET    /alerts                        告警规则列表
POST   /alerts
GET    /alerts/{id}
PUT    /alerts/{id}
DELETE /alerts/{id}
GET    /alerts/events?state=&from=&to= 已触发告警历史
```

### 6.5 删除

```
DELETE /configs/{id}/proxies*         （隧道 CRUD，frps 不可配置）
DELETE /nathole/discover
```

所有改动需同步 `openapi.yaml`、`docs/API.zh-CN.md`，并 `npm run gen:api` 重生成前端 schema。

---

## 7. 前端页面

| 页面 | 处置 | 说明 |
|---|---|---|
| Login / Settings / Theme / MainLayout | 复用 | 鉴权、主题、布局不变 |
| **ServerConfig**（原 Configs 重建） | 🔴 重建 | frps 全参数分组表单（基础/auth/transport/webServer/log/vhost/ssh 网关/端口白名单）+ 原始 TOML 双编辑 + start/stop/reload |
| **Runtime 监控**（新） | 🟢 新建 | 选实例 → 总览卡片 + 活跃客户端表 + 活跃 proxy 表（实时流量/连接数），WS 驱动刷新 |
| **Traffic 历史**（新） | 🟢 新建 | 按 server/proxy/client 选范围画入/出曲线（图表库沿用现有，无则引入轻量库） |
| **Alerts**（新） | 🟢 新建 | 告警规则 CRUD + 触发历史 |
| Dashboard | 改造 | 聚合各运行实例总览 + 系统指标 |
| System | 复用 | 服务器机器监控 |
| Logs | 复用 | frps 日志 |
| ImportExport | 改造 | 吃 server 配置 |
| ToolsNat | 删除 | 客户端语义 |
| TomlReference | 改造 | 换成 frps 参数参考 |

前端改动遵守项目第一大坑：动任何 `/api/v1` 绑定前先激活 `web-api-binding` skill 并对核 Go 源字段。

---

## 8. 时序存储与告警

- 存储：**modernc.org/sqlite**（纯 Go 无 cgo，跨平台单二进制 OK，用户已确认引入）。库文件落 `$DataDir/metrics.db`。
- 表：`traffic_points(ts, inst_id, scope, key, in, out, conns)`（按 ts 建索引，定期清理过期数据，保留窗口可配）；`alert_rules`、`alert_events`。
- 查询降采样：`step` 决定按秒/分/时聚合（SQL `GROUP BY ts/step`）。
- 告警引擎：复用采样循环，规则评估带 `ForSeconds` 去抖，状态机 `firing/resolved`，触发写 `alert_events` + 发 EventBus，配 webhook 时 POST 通知。

---

## 9. 改造范围清单（复用 / 重建 / 删除）

- **复用**：api 路由骨架与中间件、eventbus、sysinfo、logtail、manager 的 meta/自启动/快照框架、前端 Login/Settings/Theme/Layout/System/Logs。
- **重建**：pkg/config（→ ServerConfigV1）、manager/instance（→ server.Service + 子进程 worker）、configs API 语义、前端 Configs→ServerConfig、Dashboard、ImportExport、TomlReference。
- **新增**：cmd 的 `frps-worker` 子命令、internal/metrics（采样器 + SQLite 时序）、internal/alert、runtime/metrics/alerts API、前端 Runtime/Traffic/Alerts 页。
- **删除**：services/client.go、internal/conntrack、internal/api/nathole.go、frpc 专属配置/proxies/visitors/store/range、ToolsNat 页。

---

## 10. 实施分期

- **P1 地基**：`pkg/config` 重建 `ServerConfigV1`；`frps-worker` 子命令 + 父进程 worker 监管 + 握手；manager 切到子进程模型（start/stop/reload/status/日志接管）；configs CRUD + TOML + validate + import/export。**验收：前端能编辑并跑起 1~N 个 frps**。
- **P2 运行时监控**：父进程 poller 经 loopback 读 mem + /api/clients；runtime API；前端 Runtime 页 + 新增 WS 事件。**验收：frpc 连上来后前端实时看到客户端/隧道/流量**。
- **P3 历史与告警**：采样落 SQLite；metrics/traffic 曲线 API + 页面；alert 引擎 + alerts API + 页面 + webhook。**验收：曲线可查、告警可触发**。

---

## 11. 风险与未决项

1. **worker 握手健壮性**：子进程 stdout 首行传 loopback 端口/账密。需处理子进程启动失败、端口绑定失败、首行超时。实现期定超时与重试策略。
2. **用户配置里的对外 dashboard**：worker 把 `webServer` 改写成 loopback，会和「用户想对外开 frps 原生面板」冲突。本期决策：**不对外暴露 frps 原生面板**，dashboard 能力由本管理器统一提供；用户配置中的 webServer 字段仅作记录/校验，不实际对外监听（实现期在 UI 标注）。
3. **`/api/clients` 响应字段**：以 v0.69.1 frps 实际响应为准，实现期对核 `ClientRuntime` 字段。
4. **流量增量回绕**：`TodayTraffic` 跨午夜归零，采样器必须正确处理（`max(0,cur-prev)` + 跨天重置 prev），否则曲线出现负值或断崖。
5. **时序数据膨胀**：10s 采样 × N proxy 长期累积，需保留窗口 + 降采样/清理策略，避免 db 无限增长。
6. **跨平台子进程信号**：Windows 无 SIGTERM，停 worker 需用平台适配的优雅终止（沿用项目既有跨平台模式）。

---

## 12. 验收标准（总）

- `make build-host` 通过；`make test`、`go vet`、前端 `tsc -b` 全绿。
- 能创建/编辑/删除 N 份 frps 配置，能同时启动多份且互不干扰。
- 真实 frpc 客户端连上任一运行中的 frps 后，前端能看到该实例的活跃客户端、活跃 proxy、实时与历史流量。
- 配置一条告警规则并触发，能在前端看到告警事件。
- 仓库内 **无残留 frpc 客户端管理代码**（彻底替换）。
- `openapi.yaml` / `docs/API.zh-CN.md` / 前端 schema 与实际 API 一致。

---

## 13. 复审修正（2026-06-04，基于 frp v0.69.1 源码二次核验）

逐条对照 module 缓存源码（`frp@v0.69.1`）复核 §2 的 6 条技术结论：5 条成立，2 处会直接改变实现，必须修正。

### 13.1 【严重·推翻 §3.2】webServer Port=0 不会绑定随机端口

证据：`server/service.go:146-157` —— frps **仅当 `cfg.WebServer.Port > 0`** 才 `httppkg.NewServer` 起 webServer 并调 `EnableMem()`；`Port==0` 时 webServer 为 nil，**完全不监听、无从回读端口、无 mem、无 `/api/clients`**。

- 故 §3.2「强制覆盖为 `127.0.0.1:0`（让 OS 选空闲端口）」**错误**，会让 worker 彻底失去 loopback 数据通道。
- 修正：worker 必须由**父进程预分配一个非零空闲 loopback 端口**（`net.Listen("tcp","127.0.0.1:0")` 取端口后立即 Close），经 `--webport` 传入，worker 设 `sc.WebServer.Port = <非零端口>`。这就是 P1 Task 3 Step 3 的「预分配」策略——但它不再是可选优化，而是**唯一可行解**。§5.1 关于 webServer 改写的描述同步更正。

### 13.2 【确认·维持】EnableMem 非幂等 —— 但子进程模型已规避翻倍

证据：`pkg/metrics/aggregate/server.go:23-45` —— `EnableMem()` 直接 `sm.Add(...)` append 到全局切片、无去重，重复调确实翻倍。但子进程模型下**每个 worker 是独立进程**，frps 在 Port>0 时**自己**恰好调一次，我们**绝不再调** → 单进程内唯一一次 → 无翻倍。结论 5 维持。

### 13.3 【确认】frps 内置路由全部存在（P2 链路成立）

`server/api_router.go:42-48`：`/api/serverinfo`、`/api/proxy/{type}`、`/api/proxy/{type}/{name}`、`/api/traffic/{name}`、`/api/clients`、`/api/clients/{key}` 均存在（按名查单 proxy 实际路由是 `/api/proxies/{name}`）。

### 13.4 【签名修正·影响封装代码】

- ✅ `server.NewService(cfg *v1.ServerConfig) (*Service, error)`。
- ✅ `(*Service).Run(ctx)` **无返回值**（阻塞至 ctx.Done）；`(*Service).Close() error`。封装按 void 处理正确。
- ⚠️ `(*v1.ServerConfig).Complete() error` **返回 error** —— §5.1 的 `Complete()` 包装须改为返回 error。
- ⚠️ 服务端校验是**方法** `(*validation.ConfigValidator).ValidateServerConfig(c) (Warning, error)`，**非包级函数**；validate handler 须先构造 validator。
- ⚠️ mem.Collector 实际方法名：`GetServer()`/`GetProxiesByType(type)`/`GetProxyByName(name)`/`GetProxiesByTypeAndName(type,name)`/`GetProxyTraffic(name)`/`ClearOfflineProxies()`。
