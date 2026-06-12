---
name: deploy-openwrt-frps
description: Use when deploying / 部署 the frps-manager OpenWrt ipk to the local OpenWrt test router. Triggers include "部署到测试机", "发布到 192.168.1.188", "发到 op 设备 / openwrt 设备", "deploy openwrt", "装到路由器测试", "重新部署 ipk", "测试机上验证 frps 包". Builds the all-arch luci-app-frpsmgrd ipk locally, SSH/SFTP installs it, runs frpsmgrd-fetch to pull the CPU-matching binary, starts the procd service and polls the health endpoint.
---

# 部署 frps OpenWrt ipk 到本地测试设备

把本仓的 OpenWrt 壳子包 `luci-app-frpsmgrd` 一键装到本地 OpenWrt 测试路由并验证。

## 何时用
- 用户说「部署 / 发布到测试机 / op 设备 / 192.168.1.188」「重新部署 ipk」「装到路由器测试 frps 包」。
- 改完 `openwrt/**` 后要在真机回归（LuCI 页面、procd 启停、frpsmgrd-fetch 拉二进制、令牌自动生成）。

## 一步执行
```bash
cd <仓库根>
python .claude/skills/deploy-openwrt-frps/deploy.py
```
默认：用最新本地 git tag 的版本号本地打 ipk → 上传 → opkg 安装 → 拉对应架构二进制 → 启动 → 轮询健康检查 → 打印访问地址/令牌。

常用参数：
- `--version 0.0.11`  指定 ipk/二进制版本（**必须是已发布、含对应架构二进制的版本**；fetcher 会去 GitHub Release 拉）。
- `--ipk path.ipk`    用现成 ipk，跳过本地打包。
- `--reinstall`       同版本强制重装（`opkg --force-reinstall`）。脚本随后总会重跑 `frpsmgrd-fetch` 自愈二进制。
- `--set-token TOK`   显式设登录令牌（默认留空 → 首启 init.d 自动生成）。
- `--host / --user / --pass / --http-port`  覆盖连接参数。

## 前置条件
- 本机：`python3` + `paramiko`（`pip install paramiko`）、`nfpm`（`go install github.com/goreleaser/nfpm/v2/cmd/nfpm@latest`）、`bash`（git-bash）。
- 目标设备：OpenWrt/ImmortalWrt（**opkg，≤24.10**；25.12 的 apk 不读 ipk）、已装 `luci-base`/`luci-compat`、有 `curl` 或 `wget`、磁盘 ≥~32MB。
- **架构**：仅 amd64/arm64/armv7/armv6/386/riscv64（frps 依赖 modernc.org/sqlite，**不支持 mips/loong64**，fetcher 会报错退出）。

## 连接配置（密码不入库）
连接参数从 `target.env`（与本 SKILL 同目录，**已被 .gitignore 忽略**）读取，优先级 CLI > 环境变量 > target.env：
```
FRPS_DEPLOY_HOST=192.168.1.188
FRPS_DEPLOY_USER=root
FRPS_DEPLOY_PASS=********
FRPS_DEPLOY_SSH_PORT=22
FRPS_DEPLOY_HTTP_PORT=18090
```
> ⚠️ 密码只放在本地 `target.env`（gitignore），切勿写进 SKILL.md / deploy.py / 提交信息。换设备改 `target.env` 即可。

## 已固化的真机经验（deploy.py 内置处理）
1. **dropbear/busybox 无 `od` applet**（实测 ImmortalWrt 24.10 aarch64）：init.d 的 `gen_token` 用 `tr -dc 'a-f0-9' </dev/urandom`（不依赖 od）生成令牌。若改回 od 会导致首启「无法生成安全随机令牌」拒绝启动。
2. **首启慢**：守护进程首次起来要初始化 sqlite `metrics.db`，非正常退出后重开可能恢复较慢（实测偶发 ~50s）。故健康检查**轮询最长 60s**，别一次 curl 失败就判失败。
3. **`opkg --force-reinstall` 会先完整卸载**（触发 postrm，此时 fetcher 已删 → 删掉已拉的 `/usr/bin/frpsmgrd`）。脚本在安装后**总会重跑 `frpsmgrd-fetch`** 自愈。正常版本升级（装不同版本）不会触发删除。
4. **端口 :18090** 与姊妹包 `luci-app-frpcmgrd`（:18080）错开，两者可同机共存；LuCI 菜单分别在 `services/frpsmgr` 与 `services/frpcmgr`。
5. **Windows 主机偶发 `getaddrinfo failed`（Errno 10109）**：deploy.py 预解析 AF_INET 后把 socket 交给 paramiko，并带退避重试。

## 验证产物（部署后自查）
- `curl http://<host>:18090/api/v1/health` → `{"status":"ok",...}`
- `curl http://<host>:18090/` → 200，标题含「FRPS Manager」（嵌入前端）
- `http://<host>/cgi-bin/luci/admin/services/frpsmgr` → 403（已注册、受 LuCI 鉴权；非 404）
- `opkg list-installed | grep frpsmgrd`、`uci show frpsmgrd`、`logread -e frpsmgrd`

## 稳定契约（改名会破坏本 skill 与 LuCI）
服务名 `frpsmgrd`、init `/etc/init.d/frpsmgrd`、UCI `frpsmgrd.main.{http_addr,token,data_dir,version,...}`、拉取器 `/usr/sbin/frpsmgrd-fetch`、包名 `luci-app-frpsmgrd`、LuCI 入口 `admin/services/frpsmgr`。
