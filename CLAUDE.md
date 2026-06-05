# CLAUDE.md — frps-manager 项目指南

> 本文件为本仓库的项目级指令，供 Claude Code 在本项目中工作时遵循。
> 全局通用规范（语言、Windows Shell、Git、各专家 Skill）见用户级 `~/.claude/CLAUDE.md`，此处**不重复**，只记录本项目特有、且最容易踩坑的信息。

---

## 1. 这是什么

一个 **无头（headless）的 FRP 客户端管理器**：把繁琐的 `frpc.toml` 手写 + `systemctl` 手动管理，变成「装上守护进程 → 打开网页 → 点鼠标增删改启停隧道」。

- 后端：Go 守护进程 `frpmgrd`，**内嵌** frp 客户端（`github.com/fatedier/frp`，当前 v0.69.1），对外暴露 HTTP API + WebSocket。
- 前端：React + TypeScript + Vite + Ant Design 单页应用，构建产物 `web/dist` 通过 `//go:embed` **嵌进 Go 二进制**，生产环境同域。
- 单二进制交付，自带 systemd/OpenRC/launchd/Windows 服务安装脚本。

## 2. 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Go 1.25、标准库 `net/http`、`log/slog`、`coder/websocket`、内嵌 `fatedier/frp` |
| 前端 | React 19 + TypeScript + Vite 8 + Ant Design 6 + axios + CodeMirror |
| 交付 | 单二进制（embed dist）、Docker 多阶段、`scripts/install.sh` / `install.ps1`、统一管理命令 `fms` |

## 3. 架构与目录

```
cmd/frpmgrd/main.go      # 入口：子命令 serve / health / version
internal/
  api/                   # HTTP 层：server.go 路由 + 各 *.go handler + openapi.yaml
  manager/               # 核心：frpc 实例生命周期、配置加载、自启动、快照
  appcfg/                # 环境变量配置加载（FRPMGR_* → Config）
  eventbus/              # 事件总线，驱动 WS /events 推送
  logtail/  conntrack/  sysinfo/   # 日志跟踪、连接追踪、系统监控
pkg/
  version/               # 版本号（构建期 -ldflags 注入）
  config/                # ClientConfigV1 等配置模型
web/src/
  api/{client.ts,types.ts,schema.d.ts}  # axios 客户端 + 手写类型 + 由 openapi 生成的 schema
  pages/                 # 每个路由一个页面（Configs 是最复杂的核心页）
  components/ events/ theme/
scripts/                 # install.sh / install.ps1（含生成的 fms 管理命令）
docs/API.zh-CN.md        # 完整 API 字段表（前后端对接的权威参考）
```

请求大致链路：`api/server.go` 路由 → `api/<name>.go` handler → `manager` 操作 frpc 实例 → 变更经 `eventbus` 推送到前端 WS → 前端事件驱动刷新。

## 4. 常用命令（根目录 Makefile）

```bash
make build-host   # 本机平台构建 daemon（会先构建前端 dist 再 go build）→ bin/frpmgrd
make build        # Linux/amd64 构建（发布/镜像用）
make web          # 仅构建前端 dist
make test         # go test ./...
make vet          # go vet ./...
make run          # 本机构建并以 dev token 启动：FRPMGR_API_TOKEN=dev serve
make docker       # 多阶段镜像（自带 node+go，无需本地依赖）
```

前端单独操作在 `web/` 下：`npm run dev`（vite）、`npm run build`（`tsc -b && vite build`）、`npm run lint`、`npm run gen:api`（由 `internal/api/openapi.yaml` 生成 `src/api/schema.d.ts`）。

## 5. 本地开发流程

前后端**分离调试**：

1. 起后端：`make run`（监听 `:8080`，token=`dev`，数据写 `./tmp/data`）。
2. 起前端：`cd web && npm run dev`（监听 `:5173`）。`vite.config` 已把 `/api`、WS 代理到 `:8080`，前端 `client.ts` 用**相对路径** baseURL，所以走代理即可，无需配 CORS。
3. 浏览器开 `http://localhost:5173`，首次需在登录页填 API token（dev 环境即 `dev`）。token 存 localStorage，axios 拦截器自动加 `Authorization: Bearer`，401 统一跳登录。

生产/单二进制：前端已 embed，直接访问 daemon 端口同域即可。

## 6. ⚠️ 前后端 API 字段绑定（本项目第一大坑）

**改任何 `web/src/**` 里调用 `/api/v1/...` 的代码前，必须先激活 `web-api-binding` Skill 并读 Go 源确认字段名。** 这不是建议，是硬约束。核心原因：

- **大小写/命名风格不统一**：`ClientConfigV1` 子树走 **camelCase**（沿用上游 frp）；`Snapshot`/`ProxySnapshot`/系统监控/WS 事件走 **snake_case**（如 `local_ip`、`config_id`）。
- **上游 frp 的不规则 camelCase**：`natHoleStunServer`（非 `STUN`）、`dialServerKeepalive`、`tokenEndpointURL`、`connectServerLocalIP` —— 写错 key 不报错，但回读拿不到。
- **Go `encoding/json` 大小写不敏感**：写错 key 也能写成功，回读却找不到 —— 隐蔽性极强，「类型检查通过 ≠ 对接正确」，必须看一次真实请求/响应。
- **列表快照 ≠ 编辑定义**：`GET .../proxies` 返回的是 snake_case 运行时快照（无业务字段），回填编辑表单要去 `GET /configs/{id}` 取 camelCase 的完整 `config.proxies[]`。
- `decodeJSON`（[internal/api/helpers.go](internal/api/helpers.go)）启用 `DisallowUnknownFields()`，前端多发一个 key 会直接 400。

权威字段表见 [docs/API.zh-CN.md](docs/API.zh-CN.md) 与 [internal/api/openapi.yaml](internal/api/openapi.yaml)。详细对核步骤见 `.claude/skills/web-api-binding/SKILL.md`。

## 7. 配置（全部经环境变量）

由 [internal/appcfg](internal/appcfg) 读取，前缀 `FRPMGR_`：

| 变量 | 默认 | 说明 |
|---|---|---|
| `FRPMGR_API_TOKEN` | （必填） | API 鉴权令牌，登录后台凭证 |
| `FRPMGR_HTTP_ADDR` | `:8080` | 监听地址 |
| `FRPMGR_DATA_DIR` | `/data` | 数据根目录（profiles/logs/stores/meta.json） |
| `FRPMGR_CORS_ORIGINS` | `*` | CORS 白名单 |
| `FRPMGR_LOG_LEVEL` | `info` | trace/debug/info/warn/error |
| `FRPMGR_DOCS_ENABLED` | `true` | 是否开放 `/api/docs` |

安装后配置落在 `/etc/frpmgrd/frpmgrd.env`（Linux）；数据目录默认 `/var/lib/frpmgrd`。

## 8. 版本与发布

- 版本号在**构建期由 `-ldflags` 注入** [pkg/version](pkg/version)，不要在源码里硬编码。
- 内嵌的 frp 版本也记录在 `pkg/version`（`frpmgrd version` 会一并打印）。
- 发布走 CI（`.github/workflows/release.yml`），release 提交形如 `chore(release): vX.Y.Z [skip ci]`。
- 运维统一用安装脚本生成的 **`fms` 命令**：`fms start/stop/restart/status/logs -f/url/update/uninstall`（自动适配 systemd/OpenRC/launchd/Windows 服务）。改动 `install.sh`/`install.ps1` 只对新装或下次 `fms update` 生效。

## 9. 提交规范

Conventional Commits + **中文描述**，与现有历史一致：`feat(scope): …`、`fix(scope): …`、`chore(deps): …`。示例：`feat(proxy): 代理增删改自动热重载`。

## 10. 其它约束

- **Windows 开发环境**：遵循全局 `windows-shell` 规范（禁 `&&`、bash 专有语法）。注意：含中文的 `.ps1` 必须带 UTF-8 BOM（PS 5.1 否则按 ANSI 误解析），但 `.cmd`/JSON/Go/TS 等不要 BOM。
- 修改 `internal/api` 的请求/响应结构后，记得同步 `openapi.yaml`、`docs/API.zh-CN.md`，必要时跑 `npm run gen:api` 重生成前端 schema。
- 验证以事实为准：声称「修好了」前，后端跑 `make test`/`go vet`，前端跑 `tsc -b`，涉及对接的再看一次真实 Network 请求。
