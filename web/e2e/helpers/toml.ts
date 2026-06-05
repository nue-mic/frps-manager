/**
 * 生成最小可用 frps ServerConfig（API 创建 payload 的 config 字段）。
 * - 只发后端确实接受的 v1.ServerConfig 字段（DisallowUnknownFields 严格校验）。
 * - bindPort 默认 7000；测试可覆盖避免端口冲突。
 * - 不包含 frpmgr（那是请求体顶层的兄弟字段，由 api.ts 包装）。
 */
export function minimalServerConfig(bindPort = 7000) {
  return {
    bindPort,
    auth: { method: 'token', token: 'e2e-frps-token' },
    log: { level: 'info', maxDays: 1 },
  };
}
