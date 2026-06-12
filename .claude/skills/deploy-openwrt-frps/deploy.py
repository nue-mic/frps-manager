#!/usr/bin/env python3
# =============================================================================
# deploy.py — 把 frps-manager 的 OpenWrt ipk 一键部署到本地 OpenWrt 测试设备
#
#   流程：本地 nfpm 打 ipk → SFTP 上传 → opkg 安装 → frpsmgrd-fetch 拉对应
#         架构二进制 → enable+start → 轮询健康检查 → 打印访问信息。
#
#   依赖（本机）：python3 + paramiko、nfpm（go install ...nfpm@latest）、git-bash。
#   目标设备：OpenWrt/ImmortalWrt（opkg，≤24.10），已装 luci-base/luci-compat，
#            有 curl 或 wget，磁盘空间足（二进制约 25-30MB；mips/loong64 不支持）。
#
#   连接参数从以下来源读取（优先级：CLI > 环境变量 > target.env）：
#     FRPS_DEPLOY_HOST / FRPS_DEPLOY_USER / FRPS_DEPLOY_PASS
#     FRPS_DEPLOY_SSH_PORT(默认22) / FRPS_DEPLOY_HTTP_PORT(默认18090)
#   target.env 与本脚本同目录，KEY=VALUE 格式，已被 .gitignore 忽略（含密码，不入库）。
#
#   用法：
#     python deploy.py                      # 用最新本地 tag 版本，打包+部署+验证
#     python deploy.py --version 0.0.11     # 指定 ipk/二进制版本（须为已发布版本）
#     python deploy.py --ipk path/to.ipk    # 用现成 ipk，跳过本地打包
#     python deploy.py --reinstall          # 同版本强制重装（opkg --force-reinstall）
#     python deploy.py --set-token <token>  # 显式设定登录令牌（默认留空=首启自动生成）
#     python deploy.py --host 192.168.1.x   # 覆盖目标主机
# =============================================================================
import sys, os, time, socket, argparse, subprocess, shutil
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

try:
    import paramiko
except ImportError:
    sys.exit("缺少 paramiko，请先：python -m pip install paramiko")

SKILL_DIR = Path(__file__).resolve().parent
REPO_ROOT = SKILL_DIR.parents[2]          # .claude/skills/deploy-openwrt-frps → 仓库根


# --------------------------------------------------------------------------- #
# 配置加载：target.env → 环境变量 → CLI
# --------------------------------------------------------------------------- #
def load_target_env():
    cfg = {}
    f = SKILL_DIR / "target.env"
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            cfg[k.strip()] = v.strip()
    return cfg


def cfg_get(cli_val, env_key, file_cfg, default=None):
    if cli_val:
        return cli_val
    if os.environ.get(env_key):
        return os.environ[env_key]
    if file_cfg.get(env_key):
        return file_cfg[env_key]
    return default


# --------------------------------------------------------------------------- #
# 健壮连接：预解析 AF_INET 后把 socket 交给 paramiko，规避 Windows 主机偶发的
#           getaddrinfo(AF_UNSPEC) 失败（Errno 10109）；并带退避重试。
# --------------------------------------------------------------------------- #
def connect(host, port, user, pwd, retries=8):
    last = None
    for i in range(retries):
        try:
            ai = socket.getaddrinfo(host, int(port), socket.AF_INET, socket.SOCK_STREAM)[0]
            s = socket.socket(ai[0], ai[1]); s.settimeout(12); s.connect(ai[4])
            cl = paramiko.SSHClient()
            cl.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            cl.connect(host, port=int(port), username=user, password=pwd, sock=s,
                       look_for_keys=False, allow_agent=False,
                       banner_timeout=15, auth_timeout=15)
            return cl
        except Exception as e:
            last = e
            print(f"[连接重试 {i+1}/{retries}] {e}")
            time.sleep(2)
    raise SystemExit(f"SSH 连接失败（{host}:{port}）：{last!r}")


def run(cl, cmd, label=None, timeout=120, quiet=False):
    if label:
        print(f"\n### {label}")
    _i, o, e = cl.exec_command(cmd, timeout=timeout)
    out = (o.read().decode(errors="replace") + e.read().decode(errors="replace")).rstrip()
    rc = o.channel.recv_exit_status()
    if out and not quiet:
        print(out)
    if not quiet:
        print(f"[rc={rc}]")
    return rc, out


# --------------------------------------------------------------------------- #
# 定位 git-bash 的 bash（Windows 上 PATH 里的 `bash` 往往是 System32\bash.exe =
# WSL 启动器，会跑去找 WSL 发行版而非执行脚本，必须显式找 git-bash）。
# --------------------------------------------------------------------------- #
def find_bash():
    if os.name != "nt":
        return "bash"
    cands = []
    git = shutil.which("git")
    if git:
        p = Path(git).resolve()
        for up in (p.parent.parent, p.parent.parent.parent):  # .../Git/cmd/git.exe → .../Git
            cands += [up / "bin" / "bash.exe", up / "usr" / "bin" / "bash.exe"]
    cands += [Path(r"C:\Program Files\Git\bin\bash.exe"),
              Path(r"C:\Program Files\Git\usr\bin\bash.exe"),
              Path(r"C:\Program Files (x86)\Git\bin\bash.exe")]
    for c in cands:
        if c.exists():
            return str(c)
    return shutil.which("bash") or "bash"   # 兜底（可能是 WSL，会失败但有提示）


# --------------------------------------------------------------------------- #
# 本地打 ipk（调 openwrt/build-ipk.sh，需 nfpm 在 PATH）
# --------------------------------------------------------------------------- #
def build_ipk(version):
    env = dict(os.environ)
    # 把常见的 Go bin 目录补进 PATH，便于找到 nfpm
    extra = [os.path.expanduser("~/go/bin")]
    try:
        gp = subprocess.run(["go", "env", "GOPATH"], capture_output=True, text=True, timeout=15)
        if gp.returncode == 0 and gp.stdout.strip():
            extra.append(os.path.join(gp.stdout.strip(), "bin"))
    except Exception:
        pass
    env["PATH"] = os.pathsep.join(extra) + os.pathsep + env.get("PATH", "")
    bash = find_bash()
    print(f"### 本地打包 ipk（version={version}，bash={bash}）")
    # 用相对路径 + cwd=仓库根（与手动 `bash openwrt/build-ipk.sh --out tmp/deploy` 一致，
    # 避免把 Windows 反斜杠绝对路径喂给 bash 出问题）
    r = subprocess.run([bash, "openwrt/build-ipk.sh", "--version", version, "--out", "tmp/deploy"],
                       cwd=str(REPO_ROOT), env=env)
    if r.returncode != 0:
        sys.exit("打包失败：请确认已安装 nfpm（go install github.com/goreleaser/nfpm/v2/cmd/nfpm@latest）"
                 " 且本机有 git-bash")
    ipk = REPO_ROOT / "tmp" / "deploy" / f"luci-app-frpsmgrd_{version}-1_all.ipk"
    if not ipk.exists():
        sys.exit(f"未找到产物：{ipk}")
    print(f"[ipk] {ipk}  ({ipk.stat().st_size} bytes)")
    return ipk


def default_version():
    """取最新本地 git tag（vX.Y.Z → X.Y.Z）；取不到则报错要求 --version。"""
    try:
        r = subprocess.run(["git", "tag", "--list", "v*", "--sort=-v:refname"],
                           cwd=str(REPO_ROOT), capture_output=True, text=True, timeout=15)
        for line in r.stdout.splitlines():
            t = line.strip()
            if t:
                return t.lstrip("v")
    except Exception:
        pass
    sys.exit("无法确定版本，请用 --version 指定（须为已发布、含对应架构二进制的版本）")


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
def main():
    fc = load_target_env()
    ap = argparse.ArgumentParser(description="部署 frps OpenWrt ipk 到测试设备")
    ap.add_argument("--host"); ap.add_argument("--user"); ap.add_argument("--pass", dest="pwd")
    ap.add_argument("--ssh-port"); ap.add_argument("--http-port")
    ap.add_argument("--version", help="ipk/二进制版本（默认最新本地 tag）")
    ap.add_argument("--ipk", help="现成 ipk 路径，跳过本地打包")
    ap.add_argument("--reinstall", action="store_true", help="opkg --force-reinstall（同版本重装）")
    ap.add_argument("--set-token", help="显式设定登录令牌（默认留空=首启自动生成）")
    a = ap.parse_args()

    host = cfg_get(a.host, "FRPS_DEPLOY_HOST", fc)
    user = cfg_get(a.user, "FRPS_DEPLOY_USER", fc, "root")
    pwd  = cfg_get(a.pwd,  "FRPS_DEPLOY_PASS", fc)
    sshp = cfg_get(a.ssh_port, "FRPS_DEPLOY_SSH_PORT", fc, "22")
    httpp = cfg_get(a.http_port, "FRPS_DEPLOY_HTTP_PORT", fc, "18090")
    if not host or not pwd:
        sys.exit("缺少目标连接信息：请在 target.env 配置 FRPS_DEPLOY_HOST/USER/PASS，或用 --host/--user/--pass")

    version = a.version or default_version()
    if a.ipk:
        ipk = Path(a.ipk)
        if not ipk.exists():
            sys.exit(f"指定 ipk 不存在：{ipk}")
    else:
        ipk = build_ipk(version)

    print(f"\n=== 部署 {ipk.name} → {user}@{host}:{sshp}（HTTP :{httpp}，version={version}）===")
    cl = connect(host, sshp, user, pwd)

    # 1) 上传
    remote = f"/tmp/{ipk.name}"
    print(f"\n### SFTP 上传 → {remote}")
    sf = cl.open_sftp(); sf.put(str(ipk), remote); sf.close()
    print("[上传完成]")

    # 2) opkg 安装（--force-reinstall 仅在 --reinstall 时；它会先完整卸载，触发 postrm
    #    删掉已拉取的二进制 —— 不要紧，第 3 步会重新拉，自愈）
    flag = "--force-reinstall " if a.reinstall else ""
    run(cl, f"opkg install {flag}{remote} 2>&1 | tail -4", "opkg install")

    # 3) 拉对应架构二进制（无论是否重装都跑一次，自愈 binary）
    run(cl, f"frpsmgrd-fetch {version} 2>&1", "frpsmgrd-fetch（按 CPU 拉二进制）", timeout=300)

    # 4) 可选：显式设定令牌（默认留空 → 首启 init.d 自动生成）
    if a.set_token:
        run(cl, f"uci set frpsmgrd.main.token='{a.set_token}'; uci commit frpsmgrd; echo set", "设定登录令牌")

    # 5) enable + 重启
    run(cl, "/etc/init.d/frpsmgrd enable; /etc/init.d/frpsmgrd restart", "enable + restart", timeout=60)

    # 6) 轮询健康检查（首启可能因 sqlite metrics.db 恢复而慢，最长等 ~60s）
    print("\n### 健康检查（轮询，最长 60s）")
    poll = (f"for i in $(seq 1 30); do "
            f"r=$(curl -fsS -m 3 http://127.0.0.1:{httpp}/api/v1/health 2>/dev/null); "
            f"if echo \"$r\" | grep -q '\"status\"'; then echo \"OK $r\"; exit 0; fi; "
            f"sleep 2; done; echo TIMEOUT")
    _rc, out = run(cl, poll, timeout=80, quiet=True)
    healthy = out.strip().startswith("OK")
    print(out.strip())

    # 7) 汇总信息
    _rc, tok = run(cl, "uci get frpsmgrd.main.token 2>/dev/null", quiet=True)
    _rc, addr = run(cl, "uci get frpsmgrd.main.http_addr 2>/dev/null", quiet=True)
    _rc, ver  = run(cl, "/usr/bin/frpsmgrd version 2>/dev/null", quiet=True)
    _rc, listen = run(cl, f"(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -c ':{httpp}'", quiet=True)
    cl.close()

    print("\n" + "=" * 60)
    print(f"  部署{'成功 ✓' if healthy else '完成（健康检查未通过，请查 logread -e frpsmgrd）'}")
    print("-" * 60)
    print(f"  设备        : {user}@{host}")
    print(f"  二进制版本  : {ver.strip() or '未知'}")
    print(f"  监听地址    : {addr.strip()}")
    print(f"  端口监听数  : {listen.strip()}")
    print(f"  登录令牌    : {tok.strip() or '(空)'}")
    print(f"  frps 后台   : http://{host}:{httpp}")
    print(f"  LuCI 页面   : http://{host}/cgi-bin/luci/admin/services/frpsmgr  (服务 → FRPS Manager)")
    print("=" * 60)
    sys.exit(0 if healthy else 1)


if __name__ == "__main__":
    main()
