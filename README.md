# frps-manager（frpsmgrd）

> 一个用浏览器就能管理多条 frp 内网穿透隧道的「FRP 客户端管理器」。
> 一个进程同时跑多个 `frpc`，自带 **Web 管理界面** + 完整 **API**，开机自启、热重载，专为服务器/Docker 设计。

简单说：你不用再手动写一堆 `frpc.toml`、再用 `systemctl` 一个个管理了。装上它，打开网页，点点鼠标就能新增/启动/停止/查看日志/监控你的所有穿透隧道。

> 本项目从 Windows 桌面版 [frpsmgr](https://github.com/mia-clark/frps-manager) 演化而来，去掉了 Windows GUI，保留了配置模型、热重载和内嵌 frpc 的能力，改造成 Linux/服务器友好的服务。内置 frp `v0.69.1`。

---

## ✨ 它能帮你做什么

- 🖥️ **网页管理界面**：打开 `http://你的IP:端口/` 就是管理后台，新增/编辑/启停隧道、看实时日志、看监控，全在网页上完成。
- 🔀 **一个进程管多条隧道**：多个 `frpc` 实例跑在同一个进程里（不是一堆容器），省资源、好管理。
- ♻️ **热重载不断线**：改配置即时生效，已经连上的代理不掉线。
- 🔌 **完整 REST API + WebSocket**：配置增删改查、启停重载、校验、导入导出、实时事件推送、实时日志，方便二次开发对接。
- 🔐 **令牌鉴权**：单一 API 令牌（Bearer Token）保护后台，支持 CORS 配置。
- 📊 **系统监控**：CPU / 内存 / 磁盘 / 网络 / 连接数，以及每条代理的当前连接数。
- 📖 **在线接口文档**：内置 Scalar 文档，访问 `http://你的IP:端口/api/docs/` 可直接在线调试。

---

## 🚀 一键安装（推荐，macOS / Linux）

脚本会自动识别你的系统和 CPU 架构，下载对应版本，安装并注册成开机自启的系统服务。**国内服务器请用下面的镜像加速地址，复制整行回车即可。**

### ⚡ 复制即用（国内镜像加速）

> 下面所有命令都用主镜像 `gh-raw.966788.xyz`。如果某个域名不通，把命令里的域名换成任意一个[备用域名](#-镜像域名主用--备用)即可，路径不变。

**最简单：交互安装**（回车逐步选端口、令牌）

```sh
curl -fsSL https://gh-raw.966788.xyz/frp-mgr/install.sh | sh
```

**全自动安装**（一行搞定，不问任何问题）：

```sh
# 默认端口 8080 + 自动生成强随机令牌
curl -fsSL https://gh-raw.966788.xyz/frp-mgr/install.sh | sh -s -- -y

# 指定端口 9000 + 自动生成令牌
curl -fsSL https://gh-raw.966788.xyz/frp-mgr/install.sh | sh -s -- -p 9000 -y

# 指定端口 9000 + 指定令牌（端口、令牌都自己定）
curl -fsSL https://gh-raw.966788.xyz/frp-mgr/install.sh | sh -s -- -p 9000 -t 我的令牌 -y

# 随机端口 + 自动生成令牌
curl -fsSL https://gh-raw.966788.xyz/frp-mgr/install.sh | sh -s -- --port random -y

# 指定安装某个版本
curl -fsSL https://gh-raw.966788.xyz/frp-mgr/install.sh | sh -s -- -v v1.2.11 -p 9000 -y
```

**一行全自动更新**（保留端口/令牌/数据，只换程序并重启）：

```sh
curl -fsSL https://gh-raw.966788.xyz/frp-mgr/install.sh | sh -s -- --update --force
```

**一行卸载**：

```sh
curl -fsSL https://gh-raw.966788.xyz/frp-mgr/install.sh | sh -s -- --uninstall
```

> 没装 `curl`？把上面每条命令的 `curl -fsSL <地址>` 换成 `wget -qO- <地址>` 即可，例如：
> `wget -qO- https://gh-raw.966788.xyz/frp-mgr/install.sh | sh -s -- -p 9000 -t 我的令牌 -y`

装完后终端会打印**访问地址、API 令牌和常用命令**。打开浏览器访问 `http://你的IP:端口/`，填入令牌即可登录后台。

### 🌐 镜像域名（主用 + 备用）

所有域名路径都一样：`/frp-mgr/install.sh`（即仓库的 `scripts/install.sh`）。哪个快用哪个，不通就换下一个：

| 类型 | 域名 | 完整地址 |
|---|---|---|
| **主用** | `gh-raw.966788.xyz` | `https://gh-raw.966788.xyz/frp-mgr/install.sh` |
| 备用 1 | `gh-raw.s03.qzz.io` | `https://gh-raw.s03.qzz.io/frp-mgr/install.sh` |
| 备用 2 | `gh-raw.s04.qzz.io` | `https://gh-raw.s04.qzz.io/frp-mgr/install.sh` |
| 备用 3 | `gh-raw.s05.qzz.io` | `https://gh-raw.s05.qzz.io/frp-mgr/install.sh` |
| 备用 4 | `gh-raw.s06.qzz.io` | `https://gh-raw.s06.qzz.io/frp-mgr/install.sh` |
| 备用 5 | `gh-raw.s07.qzz.io` | `https://gh-raw.s07.qzz.io/frp-mgr/install.sh` |

### 🌍 海外服务器（能直连 GitHub）

直接用 GitHub 官方地址即可，用法完全一样：

```sh
# 交互安装
sh -c "$(curl -fsSL https://raw.githubusercontent.com/mia-clark/frps-manager/main/scripts/install.sh)"

# 全自动（带参数）
curl -fsSL https://raw.githubusercontent.com/mia-clark/frps-manager/main/scripts/install.sh | sh -s -- -p 9000 -t 我的令牌 -y
```

### 📋 全部参数说明

| 参数 | 作用 |
|---|---|
| `-p, --port <端口>` | 指定监听端口；传 `random` 随机端口；省略则交互/默认 `8080` |
| `-t, --token <令牌>` | 指定 API 令牌；省略则交互输入，留空自动生成强随机令牌 |
| `-v, --version <版本>` | 指定版本（如 `v1.2.11`）；省略安装最新版 |
| `-y, --yes` | 全自动模式，不交互（端口用默认、令牌自动生成） |
| `-u, --update` | 全自动更新到最新版（保留现有端口/令牌/数据） |
| `-f, --force` | 配合 `--update`，即使已是最新也强制重装 |
| `--uninstall` | 卸载 |
| `-h, --help` | 查看帮助 |

> 参数可任意组合，已传入的项就不再交互询问。也支持环境变量：`FRPSMGR_PORT=9000 FRPSMGR_API_TOKEN=xxx ASSUME_YES=1`。

### 🔄 全自动更新与定时更新

更新会**保留端口、令牌、配置和数据**，先比对版本，已是最新则跳过（除非加 `--force`）：

```sh
# 一行更新（国内镜像）
curl -fsSL https://gh-raw.966788.xyz/frp-mgr/install.sh | sh -s -- --update

# 更新到指定版本 / 强制重装
curl -fsSL https://gh-raw.966788.xyz/frp-mgr/install.sh | sh -s -- --update -v v1.2.11
curl -fsSL https://gh-raw.966788.xyz/frp-mgr/install.sh | sh -s -- --update --force
```

想无人值守自动更新？丢进 `crontab`，例如每天凌晨 4 点：

```sh
0 4 * * * curl -fsSL https://gh-raw.966788.xyz/frp-mgr/install.sh | sh -s -- --update >> /var/log/frpsmgrd-update.log 2>&1
```

### 卸载

```sh
curl -fsSL https://gh-raw.966788.xyz/frp-mgr/install.sh | sh -s -- --uninstall
```

会停止并移除系统服务、删除二进制；是否删除配置和数据目录会单独询问你。

### 安装脚本支持的系统

| 系统 | 服务方式 | 开机自启 |
|---|---|---|
| 主流 Linux（Ubuntu/Debian/CentOS/Rocky 等） | systemd | ✅ |
| Alpine 等 | OpenRC | ✅ |
| macOS | launchd | ✅ |
| 其它（无 systemd/OpenRC） | 打印手动后台运行命令 | 需手动 |

> CPU 架构自动识别：`amd64` / `arm64` / `armv7`（树莓派等）。Windows 用户请用下面的 Docker 方式，或到 [Releases](https://github.com/mia-clark/frps-manager/releases) 下载 Windows 版手动运行。

---

## 📦 其它安装方式

### 方式一：Docker（推荐用于服务器）

```bash
docker run -d --name frpsmgrd --network host \
  -e FRPSMGR_API_TOKEN="$(openssl rand -hex 32)" \
  -v $(pwd)/data:/data \
  ghcr.io/mia-clark/frps-manager:latest
```

镜像在每次推送到 `main` 和每个发布标签时自动构建（支持 amd64 + arm64）。

### 方式二：docker compose（免拉源码）

在任意空目录里：

```bash
curl -O https://raw.githubusercontent.com/mia-clark/frps-manager/main/deploy/docker-compose.standalone.yml
curl -O https://raw.githubusercontent.com/mia-clark/frps-manager/main/deploy/.env.example
mv .env.example .env
# 编辑 .env，至少把 FRPSMGR_API_TOKEN 设成一个真实令牌
docker compose -f docker-compose.standalone.yml up -d
```

### 方式三：手动下载二进制

到 [Releases](https://github.com/mia-clark/frps-manager/releases) 下载对应平台的压缩包（Linux amd64/arm64/armv7、macOS amd64/arm64、Windows amd64/arm64），解压后：

```bash
FRPSMGR_API_TOKEN=$(openssl rand -hex 32) ./frpsmgrd serve
```

---

## 🧭 安装后怎么用

| 用途 | 地址 / 命令 |
|---|---|
| **Web 管理界面** | `http://你的IP:端口/` |
| **在线 API 文档** | `http://你的IP:端口/api/docs/` |
| **健康检查** | `curl http://你的IP:端口/api/v1/health` |
| **调用 API**（需带令牌） | `curl -H "Authorization: Bearer 你的令牌" http://你的IP:端口/api/v1/version` |

> 第一次打开 Web 界面，需要填入安装时设置/生成的 **API 令牌** 才能登录。忘了令牌？看配置文件（见下）。

### 服务管理常用命令

一键安装会附带一个统一管理命令 **`fms`**（已加入 PATH），它会自动适配底层服务管理器（systemd / OpenRC / launchd / Windows 服务），无需再记平台相关的长命令：

```bash
fms start        # 启动服务
fms stop         # 停止服务
fms restart      # 重启服务
fms status       # 查看运行状态
fms logs -f      # 查看实时日志
fms enable       # 设置开机自启
fms disable      # 取消开机自启
fms url          # 显示访问地址与 API 令牌（忘了令牌时很有用）
fms config       # 查看配置（fms config edit 用编辑器打开）
fms update       # 更新到最新版（保留端口/令牌/数据）
fms uninstall    # 卸载
fms help         # 查看全部命令
```

> Windows 同样提供 `fms`（在 PowerShell 或 cmd 中执行；安装目录已加入系统 PATH，新开终端生效）。
>
> 仍想用原生命令也行：systemd 用 `systemctl status frpsmgrd` / `journalctl -u frpsmgrd -f`；macOS 用 `sudo launchctl list | grep frpsmgrd`；Windows 用 `services.msc`。

---

## ⚙️ 配置说明

一键安装后，配置写在环境变量文件里（systemd 服务读取它）：

- **Linux**：`/etc/frpsmgrd/frpsmgrd.env`（数据目录 `/var/lib/frpsmgrd`）
- **macOS**：配置写在 launchd plist 里（数据目录 `/usr/local/var/frpsmgrd`）

改完配置后执行 `fms restart` 生效（等价于 `systemctl restart frpsmgrd`）。可用的环境变量：

| 变量 | 必填 | 默认 | 说明 |
|---|---|:---:|---|
| `FRPSMGR_API_TOKEN` | ✓ | — | API 鉴权令牌（登录后台的凭证） |
| `FRPSMGR_HTTP_ADDR` |   | `:8080` | 监听地址，格式 `:端口` |
| `FRPSMGR_DATA_DIR`  |   | `/data` | 数据根目录 |
| `FRPSMGR_CORS_ORIGINS` |   | `*` | 逗号分隔的 CORS 白名单 |
| `FRPSMGR_LOG_LEVEL` |   | `info` | `trace`/`debug`/`info`/`warn`/`error` |
| `FRPSMGR_DOCS_ENABLED` |   | `true` | 是否开放 `/api/docs` 在线文档 |

### 数据目录结构

```
数据目录/
  ├── profiles/   # 每条隧道一个 .toml 配置文件
  ├── logs/       # frpc 日志，自动按天轮换
  ├── stores/     # frp visitor 状态（xtcp/visitor 用）
  └── meta.json   # 自启动列表 + 排序
```

> 升级、重装时只要保留数据目录，配置就不会丢。

---

## ❓ 常见问题

- **打开网页提示 401 / 未授权？** 令牌填错了。核对 `/etc/frpsmgrd/frpsmgrd.env` 里的 `FRPSMGR_API_TOKEN`。
- **服务起不来 / 端口被占用？** 换个端口：改 `FRPSMGR_HTTP_ADDR=:新端口` 后重启服务；或重装时用 `-p` 指定。
- **隧道显示已启动但连不上 frps？** 多半是 frps 地址/端口/令牌不对。在 Web 界面看该隧道的实时日志排查。
- **公网访问不了后台？** 检查服务器防火墙/安全组是否放行了你设置的端口。
- **想换成开机不自启？** 直接 `fms disable` 即可（跨平台通用）。

更详细的部署与 API 说明见 **[`docs/README-server.md`](docs/README-server.md)**。

---

## 🛠️ 开发与构建（给开发者）

```bash
make run            # 本地直接运行（主机模式）
make test           # 跑单元测试
make build          # 交叉编译 Linux 静态二进制 -> bin/frpsmgrd
make build-host     # 编译当前平台二进制（本地开发用）
make docker         # 用 deploy/Dockerfile 构建镜像
```

### 目录结构

```
cmd/frpsmgrd/        # 守护进程入口
internal/api/       # HTTP + WebSocket 接口、中间件（含内嵌 Web 界面）
internal/manager/   # 实例注册表 + 生命周期管理
internal/eventbus/  # 进程内事件发布订阅（用于 WS 推送）
internal/logtail/   # 日志实时 tail
internal/appcfg/    # 环境变量解析
pkg/config/         # FRP 配置模型（INI/TOML、V1 转换）
web/                # 前端源码（编译产物 embed 进二进制）
deploy/             # Dockerfile、docker-compose、.env.example
docs/               # 部署文档 + OpenAPI 设计
scripts/install.sh  # 一键安装脚本
```

---

## 📄 许可证

与上游一致，见 [`LICENSE`](LICENSE)。
