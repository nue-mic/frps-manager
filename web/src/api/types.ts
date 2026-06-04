// 手写的前后端契约类型。
//
// 来源（权威）：
//   - internal/api/configs.go        (configEnvelope / createReq)
//   - internal/manager/instance.go   (Snapshot, snake_case JSON 标签)
//   - internal/manager/manager.go    (MgrMeta, camelCase JSON 标签)
//   - pkg/config/server.go + 上游 v1.ServerConfig (ServerConfig, camelCase)
//
// 注意混合风格（本项目第一大坑）：
//   - Snapshot          → snake_case (last_error / started_at / stopped_at)
//   - MgrMeta           → camelCase  (manualStart)
//   - ServerConfig      → camelCase  (vhostHTTPPort 不是 vhostHttpPort)
//
// 不要凭驼峰直觉猜字段名，逐字对照 Go 源。

// 实例运行时快照（internal/manager/instance.go: Snapshot，snake_case）。
export interface Snapshot {
  id: string;
  name: string;
  path: string;
  state: 'stopped' | 'starting' | 'started' | 'stopping';
  last_error?: string;
  started_at?: string;
  stopped_at?: string;
}

// 管理器元数据（internal/manager/manager.go: MgrMeta，camelCase）。
export interface MgrMeta {
  name: string;
  manualStart: boolean;
}

// frps 服务端配置（上游 v1.ServerConfig 子集，camelCase）。
// GET 回来的 config 会带 Complete() 后的全量字段，这里仅声明 UI 需要的最小子集，
// 其余未知字段用索引签名原样保留（透传回 PUT 时不丢）。
export interface ServerConfig {
  bindAddr?: string;
  bindPort?: number;
  kcpBindPort?: number;
  quicBindPort?: number;
  vhostHTTPPort?: number;
  vhostHTTPSPort?: number;
  subDomainHost?: string;
  maxPortsPerClient?: number;
  auth?: {
    method?: 'token' | 'oidc';
    token?: string;
    [key: string]: unknown;
  };
  webServer?: {
    addr?: string;
    port?: number;
    user?: string;
    password?: string;
    [key: string]: unknown;
  };
  log?: {
    to?: string;
    level?: string;
    maxDays?: number;
    [key: string]: unknown;
  };
  // *bool 指针：可能为 null。
  detailedErrorsToClient?: boolean | null;
  // 上游 Complete() 会补全大量字段，原样保留。
  [key: string]: unknown;
}

// GET /configs/{id} 等接口的响应信封：Snapshot 全部字段 + config + frpmgr。
export interface ConfigEnvelope extends Snapshot {
  config: ServerConfig;
  frpmgr: MgrMeta;
}

// 列表响应。
export interface ConfigList {
  items: Snapshot[];
}

// POST /validate 响应。
export interface ValidateResp {
  valid: boolean;
  errors?: string[];
  warnings?: string[];
}
