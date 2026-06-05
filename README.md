# frps-manager（frpsmgrd）

> 一个用浏览器就能管理多套 **frps 服务端**的「无头 frps 管理器」。
> 一个守护进程同时托管多份 frps 配置档案，自带 **Web 管理面板** + 完整 **REST + WebSocket API**，开机自启、配置可视化编辑、运行时监控、历史流量曲线、告警，专为服务器/Docker 设计。

简单说：你不用再手动写一堆 `frps.toml`、用 `systemctl` 一个个管理 frps 服务了。装上它，打开网页，点点鼠标就能新增/启停/编辑/监控你的所有 frps 服务端实例，还能看每个 frps 上挂着哪些 frpc 客户端、各自的隧道与流量。

> 内嵌 [fatedier/frp](https://github.com/fatedier/frp) `v0.69.1`，每个运行中的 frps 是独立的 worker 子进程（因为 frp 的 `mem.StatsCollector` 是进程级全局单例，子进程是天然按实例隔离指标的唯一办法）。

---

## ✨ 能力一览

- 🖥️ **Web 管理面板**：打开 `http://你的IP:端口/` 就是后台。新建/编辑/启停 frps、看实时客户端列表与隧道、看流量曲线、配置告警，全在网页上完成。
- 🧩 **多实例并行**：一个守护进程同时管 N 份 frps 配置，每个跑在自己的 worker 子进程里（指标按实例隔离）。
- 🛠️ **frps 全参数可视化编辑**：基础 / 鉴权(token/OIDC) / 传输(KCP/QUIC/TCPMux/TLS) / vhost / 端口白名单 / SSH 网关 / 日志 — 9 个分组 48 字段。复杂场景兜底原始 TOML 双向编辑。
- 📡 **运行时监控（只读）**：每个 frps 的服务端总览（流量/连接/客户端数）、活跃 frpc 客户端、活跃 proxy（含按名查单个）— 经 worker loopback 实时读 frps 原生 mem 指标。
- 📈 **历史流量曲线**：自带 SQLite 时序库，每 10s 采样区间增量，前端 recharts 渲染。
- 🚨 **告警引擎**：阈值规则（连接数 / 流量速率） + 持续时间去抖 + firing/resolved 状态机 + 可选 webhook 推送。
- 🔌 **完整 REST API + WebSocket**：CRUD / 生命周期 / 校验 / 导入导出 / 实时事件 / 实时日志，方便二次开发对接。OpenAPI 3.1 spec 可在 `/api/docs/` 在线调试。
- 🔐 **Bearer 鉴权**：单一 API 令牌保护管理面板，支持 CORS 配置。
- 📊 **系统监控**：CPU / 内存 / 磁盘 / 网络 / 连接数 / 进程信息。
- 📦 **单二进制交付**：纯 Go、嵌入前端 dist、内置 SQLite 驱动（`modernc.org/sqlite` 无 cgo），开箱即用。

---

## 🚀 一键安装（推荐，macOS / Linux）

脚本会自动识别系统和 CPU 架构，下载对应版本，注册为开机自启的系统服务。**国内服务器请用下面的镜像加速地址。**

### ⚡ 复制即用（国内镜像加速）

> 下面命令都用主镜像 `gh-raw.966788.xyz`。某个域名不通就换备用域名（[见下](#-镜像域名主用--备用)），路径不变。

**最简单：交互安装**（回车逐步选端口、令牌）

```sh
curl -fsSL https://gh-raw.966788.xyz/frps-mgr/install.sh | sh
```

**全自动安装**（一行搞定）：

```sh
# 默认端口 8080 + 自动生成强随机令牌
curl -fsSL https://gh-raw.966788.xyz/frps-mgr/install.sh | sh -s -- -y

# 指定端口 9000 + 指定令牌
curl -fsSL https://gh-raw.966788.xyz/frps-mgr/install.sh | sh -s -- -p 9000 -t 我的令牌 -y

# 随机端口 + 自动生成令牌
curl -fsSL https://gh-raw.966788.xyz/frps-mgr/install.sh | sh -s -- --port random -y
```

**全自动更新**（保留端口/令牌/数据，只换程序并重启）：

```sh
curl -fsSL https://gh-raw.966788.xyz/frps-mgr/install.sh | sh -s -- --update --force
```

**一行卸载**：

```sh
curl -fsSL https://gh-raw.966788.xyz/frps-mgr/install.sh | sh -s -- --uninstall
```

> 没装 `curl`？把 `curl -fsSL <地址>` 换成 `wget -qO- <地址>` 即可。

装完后终端会打印**访问地址、API 令牌和常用命令**。浏览器打开 `http://你的IP:端口/`，填令牌登录。

### 🌐 镜像域名（主用 + 备用）

所有路径都一样：`/frps-mgr/install.sh`（即仓库的 `scripts/install.sh`）。

| 类型 | 域名 |
|---|---|
| **主用** | `https://gh-raw.966788.xyz/frps-mgr/install.sh` |
| 备用 1 | `https://gh-raw.s03.qzz.io/frps-mgr/install.sh` |
| 备用 2 | `https://gh-raw.s04.qzz.io/frps-mgr/install.sh` |
| 备用 3 | `https://gh-raw.s05.qzz.io/frps-mgr/install.sh` |
| 备用 4 | `https://gh-raw.s06.qzz.io/frps-mgr/install.sh` |
| 备用 5 | `https://gh-raw.s07.qzz.io/frps-mgr/install.sh` |

### 🌍 海外服务器（能直连 GitHub）

```sh
# 交互安装
sh -c "$(curl -fsSL https://raw.githubusercontent.com/mia-clark/frps-manager/main/scripts/install.sh)"

# 全自动
curl -fsSL https://raw.githubusercontent.com/mia-clark/frps-manager/main/scripts/install.sh | sh -s -- -p 9000 -t 我的令牌 -y
```

### 📋 安装脚本参数

| 参数 | 作用 |
|---|---|
| `-p, --port <端口>` | 指定监听端口；传 `random` 随机端口；省略则交互/默认 `8080` |
| `-t, --token <令牌>` | 指定 API 令牌；省略则交互输入，留空自动生成强随机令牌 |
| `-v, --version <版本>` | 指定版本（如 `v0.0.3`）；省略安装最新版 |
| `-y, --yes` | 全自动模式，端口默认 + 令牌随机 |
| `-u, --update` | 全自动更新（保留现有端口/令牌/数据） |
| `-f, --force` | 配合 `--update`，即使已是最新也强制重装 |
| `--uninstall` | 卸载 |
| `-h, --help` | 帮助 |

> 也支持环境变量：`FRPSMGR_PORT=9000 FRPSMGR_API_TOKEN=xxx ASSUME_YES=1`。

### 🔄 定时自动更新

丢进 `crontab`，例如每天凌晨 4 点：

```sh
0 4 * * * curl -fsSL https://gh-raw.966788.xyz/frps-mgr/install.sh | sh -s -- --update >> /var/log/frpsmgrd-update.log 2>&1
```

### 安装脚本支持的系统

| 系统 | 服务方式 | 开机自启 |
|---|---|---|
| 主流 Linux（Ubuntu/Debian/CentOS/Rocky 等） | systemd | ✅ |
| Alpine 等 | OpenRC | ✅ |
| macOS | launchd | ✅ |
| 其它（无 systemd/OpenRC） | 打印手动后台运行命令 | 需手动 |

> CPU 架构自动识别：`amd64` / `arm64` / `armv7`（树莓派等） / `riscv64` / `386`。Windows 用户请用 Docker 或到 [Releases](https://github.com/mia-clark/frps-manager/releases) 下载 Windows 版手动运行。

---

## 📦 其它安装方式

### 方式一：Docker（推荐用于服务器）

```bash
docker run -d --name frpsmgrd --network host \
  -e FRPSMGR_API_TOKEN="$(openssl rand -hex 32)" \
  -v $(pwd)/data:/data \
  ghcr.io/mia-clark/frps-manager:latest
```

> 用 `--network host` 才能让里面的 frps worker 监听宿主机端口对外提供服务。

镜像每次推送到 `main` 和每个发布 tag 自动构建，支持 `linux/amd64` + `linux/arm64`。

### 方式二：docker compose（免拉源码）

```bash
mkdir frpsmgrd && cd frpsmgrd
curl -O https://raw.githubusercontent.com/mia-clark/frps-manager/main/deploy/docker-compose.standalone.yml
curl -O https://raw.githubusercontent.com/mia-clark/frps-manager/main/deploy/.env.example
mv .env.example .env
# 编辑 .env，至少把 FRPSMGR_API_TOKEN 设成真实令牌
docker compose -f docker-compose.standalone.yml up -d
```

### 方式三：手动下载二进制

到 [Releases](https://github.com/mia-clark/frps-manager/releases) 下载对应平台压缩包，解压后：

```bash
FRPSMGR_API_TOKEN=$(openssl rand -hex 32) ./frpsmgrd serve
```

支持的平台：Linux (amd64/arm64/arm v6/v7/386/riscv64)、macOS (amd64/arm64)、Windows (amd64/arm64/386)、FreeBSD (amd64/arm64)。

---

## 🧭 用起来

| 用途 | 地址 / 命令 |
|---|---|
| **Web 管理面板** | `http://你的IP:端口/` |
| **在线 API 文档** | `http://你的IP:端口/api/docs/`（Scalar UI） |
| **健康检查** | `curl http://你的IP:端口/api/v1/health` |
| **调用 API** | `curl -H "Authorization: Bearer 你的令牌" http://你的IP:端口/api/v1/version` |

> 第一次打开 Web 面板，需要填入安装时设置/生成的 **API 令牌** 才能登录。忘了令牌？看配置文件（下方）。

### 创建一个 frps 实例（curl 示例）

```bash
TOKEN=你的令牌
BASE=http://你的IP:端口

# 1. 创建配置
curl -X POST $BASE/api/v1/configs \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "id": "main",
    "config": {
      "bindPort": 7000,
      "vhostHTTPPort": 8080,
      "auth": { "method": "token", "token": "强随机字符串" }
    },
    "frpsmgr": { "name": "主服务端", "manualStart": false }
  }'

# 2. 启动
curl -X POST $BASE/api/v1/configs/main/start -H "Authorization: Bearer $TOKEN"

# 3. 看运行时
curl -H "Authorization: Bearer $TOKEN" $BASE/api/v1/runtime/main/overview
curl -H "Authorization: Bearer $TOKEN" $BASE/api/v1/runtime/main/clients
```

完整 API 见 [`docs/API.zh-CN.md`](docs/API.zh-CN.md) 和 [`internal/api/openapi.yaml`](internal/api/openapi.yaml)。

### 统一管理命令 `fms`

一键安装会附带 **`fms`** 命令（已加入 PATH），自动适配 systemd / OpenRC / launchd / Windows 服务：

```bash
# 服务管理
fms start          # 启动服务
fms stop           # 停止服务
fms restart        # 重启服务
fms status         # 查看运行状态
fms logs -f        # 实时跟踪日志（不加 -f 看最近若干行）
fms enable         # 设置开机自启
fms disable        # 取消开机自启

# 信息查看
fms info           # 显示完整运行信息(地址/令牌/路径/状态) + 命令面板 ← 忘了令牌看这个
fms config         # 查看配置文件（fms config edit 用编辑器打开）
fms version        # 显示版本信息

# 安装维护
fms install [参数] # 重新安装（参数透传给 install.sh / install.ps1）
fms update         # 更新到最新版（保留端口/令牌/数据）
fms uninstall      # 卸载

fms help           # 显示帮助
```

> 仍想用原生命令也行：systemd 用 `systemctl status frpsmgrd` / `journalctl -u frpsmgrd -f`；macOS 用 `sudo launchctl list | grep frpsmgrd`；Windows 用 `services.msc`。

---

## ⚙️ 配置（环境变量）

| 变量 | 必填 | 默认 | 说明 |
|---|---|:---:|---|
| `FRPSMGR_API_TOKEN` | ✓ | — | API 鉴权令牌（登录后台的凭证） |
| `FRPSMGR_HTTP_ADDR` |   | `:8080` | 监听地址，格式 `:端口` |
| `FRPSMGR_DATA_DIR`  |   | `/data` | 数据根目录 |
| `FRPSMGR_CORS_ORIGINS` |   | `*` | 逗号分隔的 CORS 白名单 |
| `FRPSMGR_LOG_LEVEL` |   | `info` | `trace`/`debug`/`info`/`warn`/`error` |
| `FRPSMGR_DOCS_ENABLED` |   | `true` | 是否开放 `/api/docs` 在线文档 |

一键安装后配置文件位置：
- **Linux**：`/etc/frpsmgrd/frpsmgrd.env`（数据目录 `/var/lib/frpsmgrd`）
- **macOS**：launchd plist（数据目录 `/usr/local/var/frpsmgrd`）

改完后 `fms restart` 生效。

### 数据目录结构

```
数据目录/
  ├── profiles/    # 每份 frps 配置一个 <id>.toml(纯 frp 原生格式)
  ├── logs/        # 每实例独立 <id>.log(worker stdout/stderr)
  ├── metrics.db   # SQLite 时序库(traffic_points/alert_rules/alert_events)
  └── meta.json    # 实例显示名、手动启动标记、列表排序、日志清空水位
```

> 升级、重装时保留数据目录，配置就不会丢。

---

## 🏗️ 架构（一句话版）

```
浏览器/API 客户端
       │ Bearer
       ▼
┌──────────────────────────────────────────────┐
│ frpsmgrd (父进程, REST+WS+embed 前端)         │
│  ├── manager: 注册表 + 生命周期               │
│  ├── eventbus: WS 推送(状态/告警)             │
│  ├── metrics: 采样器+SQLite+告警引擎          │
│  └── workers: spawn N 个 frps 子进程          │
└──────────────────────────────────────────────┘
       │ re-exec 自身 frps-worker
       ▼
┌──────────────────────────────────────────────┐
│ frps-worker × N (每个内嵌一个 frps)          │
│  webServer 强制 loopback 127.0.0.1:<随机端口>  │
│  父进程经 loopback HTTP 读 mem 指标和 clients │
└──────────────────────────────────────────────┘
       │ TCP/UDP/KCP/QUIC
       ▼
   外部 frpc 客户端连过来注册隧道
```

设计细节见 [`docs/superpowers/specs/2026-06-04-frps-manager-transformation-design.md`](docs/superpowers/specs/2026-06-04-frps-manager-transformation-design.md)。

---

## ❓ 常见问题

- **打开网页提示 401？** 令牌填错。核对 `/etc/frpsmgrd/frpsmgrd.env` 里的 `FRPSMGR_API_TOKEN`。
- **服务起不来 / 端口被占用？** 换端口：改 `FRPSMGR_HTTP_ADDR=:新端口` 后 `fms restart`；或重装用 `-p`。
- **创建 frps 配置后启动失败？** 检查 `bindPort` 是否被占；Web 面板的「日志」tab 看子进程 stderr。
- **客户端连过来但 Runtime 看不到？** 确认 frpc 配置的 `auth.token` 与 frps 配置里的一致；确认网络通；frps 子进程必须处于 `started` 状态。
- **reload 是不是热重载？** 不是。**frps 服务端参数变更需重启进程才生效**，所以 reload = stop + start。这是 frps 自身的限制，不是本管理器的偷懒。
- **想换成开机不自启？** `fms disable`（跨平台通用）。

更详细的部署与 API 说明见 [`docs/README-server.md`](docs/README-server.md) 与 [`docs/API.zh-CN.md`](docs/API.zh-CN.md)。

---

## 🛠️ 开发与构建

```bash
make run            # 本地直接运行（含 dev token）
make test           # 单测
make build          # 交叉编译 Linux 静态二进制 → bin/frpsmgrd
make build-host     # 本地平台二进制
make docker         # 构建镜像（deploy/Dockerfile）
```

前端单独操作：

```bash
cd web
npm ci
npm run dev         # vite 起 :5173，代理到后端 :8080
npm run build       # 构建 dist（embed 进 Go 二进制）
npm run lint
npm run test:e2e    # Playwright 端到端
npm run gen:api     # 由 openapi.yaml 重生成 src/api/schema.d.ts
```

### 目录结构

```
cmd/frpsmgrd/         # 父守护进程入口 + frps-worker 子命令
internal/api/         # HTTP/WS 路由 + 中间件 + OpenAPI spec
internal/manager/     # 实例注册表 + 生命周期 + worker 子进程监管 + meta
internal/metrics/     # SQLite 时序 + 采样器 + 告警引擎
internal/eventbus/    # 进程内事件 (WS 推送源)
internal/logtail/     # 文件 tail (WS 日志)
internal/sysinfo/     # 系统监控
internal/appcfg/      # 环境变量解析
pkg/config/           # ServerConfigV1 (上游 v1.ServerConfig 包装)
pkg/version/          # 版本号 (-ldflags 注入)
services/frps.go      # frps 服务封装 (NewService/Run/Close)
web/                  # 前端 React+Vite+AntD (产物 embed 进二进制)
deploy/               # Dockerfile + docker-compose + .env.example
docs/                 # 部署文档 + OpenAPI + 设计/规划历史
scripts/              # install.sh / install.ps1 / api-smoke.sh
```

### 测试

```bash
go test ./...                                  # 后端单测
bash scripts/api-smoke.sh                      # 71 用例 API 烟测（需 daemon 在 :8088 上跑）
cd web && npx playwright test                  # 端到端 UI
```

---

## 📄 许可证

与上游 frp 一致，见 [`LICENSE`](LICENSE)。
