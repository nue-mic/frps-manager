// frps 服务端 (v1) 配置参考片段集
//
// 数据源：上游 fatedier/frp@v0.69.1 pkg/config/v1/server.go + common.go
// 所有片段都是合法 TOML，可直接粘贴到本管理器的「高级 TOML 配置」编辑器。
//
// 重要说明：
//   1. 顶部必须有 version = "1"，否则 frp 会按 legacy ini 解析。
//   2. 本管理器在 worker 子进程启动时会把 webServer 强制覆盖为 loopback +
//      随机账号密码，所以 toml 里写的 webServer 设置「不会对外生效」，仅作语义参考。
//   3. 客户端隧道 (proxies / visitors) 是 frpc 运行时注册的，不在 frps 配置里写。
//      不要把 [[proxies]] / [[visitors]] / serverAddr 等客户端字段抄进这里。

export interface Snippet {
  key: string;
  title: string;
  hint: string;
  toml: string;
}

export interface SnippetGroup {
  key: string;
  label: string;
  items: Snippet[];
}

export const TOML_SNIPPETS: SnippetGroup[] = [
  {
    key: 'basic',
    label: '基础',
    items: [
      {
        key: 'minimal',
        title: '最小可用 frps',
        hint: '只需 version + bindPort 就能跑一个 frps；客户端 frpc 用同样的端口和 token 连进来即可。',
        toml: `# ===========================================================
# frps 最小可用配置
# -----------------------------------------------------------
# 说明（重要）:
#   - 顶部 version 必填，否则 frp 会回退到 legacy ini 解析模式
#   - frps 只负责服务端骨架（端口/虚拟主机/鉴权/传输）
#   - 客户端隧道由 frpc 运行时注册，不在 frps 配置里写
#   - 本管理器会接管 webServer 字段，把它绑到 loopback + 随机账密
# ===========================================================

version = "1"

# 控制端口：frpc 通过这个端口连上 frps 注册隧道
# 默认 7000；公网部署时务必配合防火墙白名单
bindPort = 7000
`,
      },
      {
        key: 'public-deploy',
        title: '典型公网部署',
        hint: '一个可直接公网跑的 frps：控制端口 + HTTP/HTTPS 虚拟主机 + 子域名 + token 鉴权 + 日志。',
        toml: `# ===========================================================
# frps 典型公网部署示例
# 适用：单机公网服务器，给若干客户端做 HTTP/HTTPS 反代 + TCP 隧道
# ===========================================================

version = "1"

# 控制连接监听地址与端口
bindAddr = "0.0.0.0"
bindPort = 7000

# HTTP 虚拟主机端口：frpc 端 type="http" 的代理通过这个端口对外暴露
vhostHTTPPort = 80
# HTTPS 虚拟主机端口：frpc 端 type="https" 的代理走这个端口
vhostHTTPSPort = 443

# 子域名根域：frpc 配置 subdomain = "myapp" 时，实际访问域名 = myapp.example.com
# 要求 *.example.com 的 DNS 解析指向本机
subDomainHost = "example.com"

# 鉴权
[auth]
method = "token"
# 与所有 frpc 共享的密钥，必须强随机
token = "PLEASE_CHANGE_ME_TO_A_LONG_RANDOM_STRING"

# 日志
[log]
# trace / debug / info / warn / error
level = "info"
# 文件路径或 "console"
to = "./frps.log"
# 保留天数（按日切割）
maxDays = 3
`,
      },
    ],
  },
  {
    key: 'auth',
    label: '鉴权',
    items: [
      {
        key: 'token',
        title: 'Token 鉴权（最常见）',
        hint: 'frps 与 frpc 共享一个静态 token；可通过 additionalScopes 在心跳/新工作连接里也校验。',
        toml: `# ===========================================================
# Token 鉴权 — 所有 frpc 必须提供相同 token 才能注册隧道
# ===========================================================

version = "1"
bindPort = 7000

[auth]
# token / oidc，默认 token
method = "token"
# 与 frpc 端 [auth].token 必须完全一致
token = "vX8mKq3JwLz9NpRt5Yy2Hc7Bf4Gg1Db6"

# 默认 frps 只在登录握手时校验 token。
# additionalScopes 让 frps 在更多场景也校验：
#   - "HeartBeats"    心跳包也带 token
#   - "NewWorkConns"  每条新工作连接都带 token
# 安全性更高，但会增加少量 CPU 与 RTT 开销
additionalScopes = ["HeartBeats", "NewWorkConns"]
`,
      },
      {
        key: 'oidc',
        title: 'OIDC 鉴权',
        hint: '与 Keycloak/Auth0/Okta 等 OIDC Provider 集成；frps 会验证 frpc 上送的 access token。',
        toml: `# ===========================================================
# OIDC 鉴权 — frpc 先从 IdP 拿 access token，frps 用 issuer 公钥验证
# 字段名严格按上游 v1.AuthOIDCServerConfig 的 json tag
# ===========================================================

version = "1"
bindPort = 7000

[auth]
method = "oidc"

[auth.oidc]
# OIDC issuer URL（用于拉取 JWKS 验证签名），必须与 token 内的 iss 一致
issuer = "https://idp.example.com/auth/realms/myrealm"
# 期望 token 的 audience（aud claim）；留空则跳过 audience 检查
audience = "frp"
# 调试期可临时打开；生产严禁置 true
skipExpiryCheck = false
skipIssuerCheck = false
`,
      },
    ],
  },
  {
    key: 'transport',
    label: '传输',
    items: [
      {
        key: 'kcp-quic',
        title: 'KCP / QUIC 监听',
        hint: '除 TCP 控制端口外，额外开 KCP/QUIC 端口；frpc 设置 transport.protocol = "kcp"/"quic" 即可走这两条通道。',
        toml: `# ===========================================================
# 额外监听 KCP / QUIC 端口（适用于丢包率高 / TCP 拥塞严重的链路）
# 控制端口（bindPort）依旧保留，由 frpc 的 transport.protocol 决定走哪条
# ===========================================================

version = "1"
bindPort = 7000

# KCP 监听端口（UDP 协议承载）；0 = 禁用
kcpBindPort = 7000

# QUIC 监听端口；0 = 禁用
quicBindPort = 7001

# QUIC 调优（可不写，默认值见注释）
[transport.quic]
# QUIC 应用层 keep-alive 周期（秒），默认 10
keepalivePeriod = 10
# 单连接最大空闲（秒），默认 30
maxIdleTimeout = 30
# 单连接允许的最大并发流，默认 100000
maxIncomingStreams = 100000
`,
      },
      {
        key: 'tcpmux',
        title: 'TCP 多路复用',
        hint: '默认就开着的 tcpMux，可调整保活间隔；与 frpc 端 transport.tcpMux 必须保持一致。',
        toml: `# ===========================================================
# transport.tcpMux — TCP Stream Multiplexing
# 把多个逻辑连接复用到一条 TCP 连接上，减少握手与端口占用
# 必须与 frpc 端 transport.tcpMux 保持一致（true/true 或 false/false）
# ===========================================================

version = "1"
bindPort = 7000

[transport]
# 默认 true；除非有特殊兼容性问题，否则别关
tcpMux = true
# tcpMux 内层心跳间隔（秒），默认 30
tcpMuxKeepaliveInterval = 30
`,
      },
      {
        key: 'heartbeat-limits',
        title: '心跳与连接池上限',
        hint: '调节 frps 容忍 frpc 心跳超时的时长，以及单个客户端可以预建的连接池大小、端口数上限。',
        toml: `# ===========================================================
# 心跳超时 + 连接池上限 + 每客户端端口上限
# ===========================================================

version = "1"
bindPort = 7000

[transport]
# 客户端心跳超时（秒）；超过则关闭连接。
# 当 tcpMux = true 时默认 -1（依赖 tcpMux 自身心跳）；
# 当 tcpMux = false 时默认 90。设置 -1 表示禁用应用层心跳。
heartbeatTimeout = 90
# 每个代理允许的预建连接池大小上限（默认 5）
# frpc 在 transport.poolCount 提交，frps 会用这个值做上限
maxPoolCount = 5

# 单个客户端最多可占用多少个公网端口（0 = 不限制）
# 用于多租户/共享 frps 场景，防止某个客户端把端口吃光
maxPortsPerClient = 50
`,
      },
    ],
  },
  {
    key: 'vhost',
    label: '虚拟主机',
    items: [
      {
        key: 'http-https',
        title: 'HTTP / HTTPS 反代',
        hint: 'frps 通过 vhostHTTP[S]Port 接收外网 80/443 流量，按 SNI / Host 头分发到对应 frpc 的 http/https 代理。',
        toml: `# ===========================================================
# HTTP / HTTPS 反向代理入口
# frpc 端创建 type = "http" 或 "https" 的代理时必须的服务端骨架
# ===========================================================

version = "1"
bindPort = 7000

# HTTP 虚拟主机端口（一般直接 80）
vhostHTTPPort = 80
# HTTPS 虚拟主机端口（一般直接 443，TLS 不在 frps 解，按 SNI 透传给 frpc）
vhostHTTPSPort = 443

# 子域名根域：frpc 端配置 subdomain="myapp" 时，对外域名 = myapp.example.com
# 要求 *.example.com 的 DNS A/AAAA 解析指向本机
subDomainHost = "example.com"

# vhost HTTP 服务器响应头超时（秒），默认 60
vhostHTTPTimeout = 60

# 自定义 404 页面（可选）
# custom404Page = "/etc/frps/404.html"
`,
      },
      {
        key: 'https-cert',
        title: 'HTTPS 证书（frps 端 TLS 终结）',
        hint: '只在需要 frps 自己解 TLS 时才配；多数场景是 SNI 透传给 frpc，无需写证书。',
        toml: `# ===========================================================
# frps 端 HTTPS 证书
# 注意：默认 vhostHTTPSPort 是按 SNI 透传给 frpc，不需要证书。
# 只有当你想让 frps 自己做 TLS 终结时才填以下字段。
# ===========================================================

version = "1"
bindPort = 7000

vhostHTTPSPort = 443

# WebServer 的 TLS 字段（注意：本管理器会接管 webServer，所以这里仅作语义参考）
# 真正用于 vhostHTTPS 的证书需要通过插件或在 frpc 端用 https2https/https2http 实现
[webServer.tls]
certFile = "/etc/frps/server.crt"
keyFile = "/etc/frps/server.key"
`,
      },
    ],
  },
  {
    key: 'dashboard',
    label: '面板',
    items: [
      {
        key: 'webServer-reference',
        title: '原生 webServer 面板（仅作语义参考）',
        hint: '本管理器会在启动 frps worker 时把 webServer 强制覆盖为 loopback + 随机账密，所以下面的字段写了也不会对外生效。这里只是展示上游 v1.WebServerConfig 的字段名以便理解。',
        toml: `# ===========================================================
# [webServer] — frps 原生管理面板（HTTP API + Dashboard）
# ⚠️ 重要：本管理器会在 worker 子进程启动时强制把以下字段覆盖为
#         127.0.0.1 + 随机端口 + 随机账号密码（loopback 安全模型）。
#         你在这里写的内容「不会对外生效」，仅作语义参考。
#
# 上游字段来源：v1.WebServerConfig （pkg/config/v1/common.go）
# ===========================================================

version = "1"
bindPort = 7000

[webServer]
# 监听地址（管理器会覆盖为 127.0.0.1）
addr = "0.0.0.0"
# 监听端口（管理器会覆盖为随机端口）
port = 7500
# Dashboard 登录用户名（管理器会覆盖为随机字符串）
user = "admin"
# Dashboard 登录密码（管理器会覆盖为随机字符串）
password = "PLEASE_CHANGE_ME"
# 自定义 Dashboard 静态资源目录（可不写，使用内嵌资源）
# assetsDir = "/var/www/frps-dashboard"
# 是否暴露 Go pprof（仅调试时开）
pprofEnable = false

# 管理面板单独的 TLS（同样会被管理器覆盖）
# [webServer.tls]
# certFile = "/etc/frps/admin.crt"
# keyFile  = "/etc/frps/admin.key"
`,
      },
    ],
  },
  {
    key: 'advanced',
    label: '高级',
    items: [
      {
        key: 'allowPorts',
        title: '端口白名单 (allowPorts)',
        hint: 'frpc 申请 remotePort 时只放行白名单内的端口；防止客户端随意占用敏感端口。支持单端口 (single) 与区间 (start/end)。',
        toml: `# ===========================================================
# allowPorts — frps 允许 frpc 申请的远程端口白名单
# 上游类型：[]types.PortsRange，每项是 { start, end } 或 { single }
# （字段名严格按 pkg/config/types/types.go: Start / End / Single）
# ===========================================================

version = "1"
bindPort = 7000

# 例子：放行 6000-7000、8080-8090、以及单独的 9000/9001
allowPorts = [
  { start = 6000, end = 7000 },
  { start = 8080, end = 8090 },
  { single = 9000 },
  { single = 9001 },
]
`,
      },
      {
        key: 'tcpmux-httpconnect',
        title: 'TCPMUX HTTP CONNECT 端口',
        hint: '让多条 TCP 隧道共享一个 frps 端口，通过 HTTP CONNECT 域名分流。frpc 侧需要 type = "tcpmux" + multiplexer = "httpconnect"。',
        toml: `# ===========================================================
# tcpmuxHTTPConnectPort — 多条 TCP 隧道共用一个公网端口
# frpc 端创建 type = "tcpmux"、multiplexer = "httpconnect" 的代理时所需
# 字段名注意：tcpmuxHTTPConnectPort（mux 小写、HTTP 大写、Connect 首字母大写）
# ===========================================================

version = "1"
bindPort = 7000

# 同一端口承载多条 tcpmux 隧道，通过 HTTP CONNECT 头里的域名分流
tcpmuxHTTPConnectPort = 1337

# 如果只想做透传（不解析 HTTP CONNECT 内容）：
# tcpmuxPassthrough = true
`,
      },
      {
        key: 'ssh-tunnel-gateway',
        title: 'SSH Tunnel Gateway',
        hint: '让用户用标准 `ssh -R` 命令直接打隧道到 frps，无需安装 frpc。字段名严格按上游 SSHTunnelGateway 结构。',
        toml: `# ===========================================================
# SSH Tunnel Gateway — 直接用 ssh -R 命令打隧道，无需 frpc
# 用法示例（用户侧）：
#   ssh -R :6000:127.0.0.1:22 frpc@your-frps-host -p 2200
#
# 字段名来源：v1.SSHTunnelGateway（pkg/config/v1/server.go）
# ===========================================================

version = "1"
bindPort = 7000

[sshTunnelGateway]
# SSH Gateway 监听端口（0 = 禁用）
bindPort = 2200
# 自动生成的 SSH 私钥保存路径（首次启动自动创建）
# 注意字段名是 autoGenPrivateKeyPath（Auto-Gen-Private-Key-Path，缩写 Gen 紧贴 Auto）
autoGenPrivateKeyPath = "./.autogen_ssh_key"
# 也可以指定一个已有的私钥文件（与 autoGenPrivateKeyPath 二选一）
# privateKeyFile = "/etc/frps/ssh_host_rsa_key"
# 授权的客户端公钥列表（OpenSSH authorized_keys 格式）
# authorizedKeysFile = "/etc/frps/authorized_keys"
`,
      },
    ],
  },
];

export function findSnippet(groupKey: string, itemKey: string): Snippet | undefined {
  const g = TOML_SNIPPETS.find((x) => x.key === groupKey);
  return g?.items.find((x) => x.key === itemKey);
}

export function defaultSnippet(): { groupKey: string; itemKey: string } {
  return { groupKey: TOML_SNIPPETS[0].key, itemKey: TOML_SNIPPETS[0].items[0].key };
}
