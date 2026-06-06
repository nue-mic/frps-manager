import client from './client';

/**
 * 版本检查响应 —— 字段逐字对齐后端 internal/api/update.go 的 Check handler。
 * 与 /api/v1/system/* 一致采用 snake_case。
 *
 * 必返字段：current / frp / deployment_mode / self_update_enabled /
 *           has_update / can_self_update / reason
 * 仅成功时返回：latest / changelog / html_url / published_at
 * 仅失败时返回：check_error
 */
export interface VersionCheckResp {
  current: string;
  frp?: string;
  deployment_mode: string; // docker | systemd | openrc | launchd | windows-service | manual
  self_update_enabled: boolean;
  has_update: boolean;
  can_self_update: boolean;
  reason: string;
  latest?: string;
  changelog?: string;
  html_url?: string;
  published_at?: string;
  check_error?: string;
}

/** POST /api/v1/system/update 的 202 响应体。 */
export interface UpdateStartResp {
  status: string;
  from: string;
  to: string;
  message: string;
}

/** 检查最新版本（force=true 绕过后端 ~1h 缓存）。 */
export async function checkVersion(force = false): Promise<VersionCheckResp> {
  const resp = await client.get<VersionCheckResp>('/api/v1/version/check', {
    params: force ? { force: 1 } : undefined,
  });
  return resp.data;
}

/** 触发一键更新（force=true 即使已是最新也强制重装）。返回后服务即将重启。 */
export async function startUpdate(force = false): Promise<UpdateStartResp> {
  const resp = await client.post<UpdateStartResp>('/api/v1/system/update', null, {
    params: force ? { force: 1 } : undefined,
  });
  return resp.data;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 轮询 /api/v1/version，直到 daemon 版本不再等于 fromVersion（即新进程已起来），
 * 或超时。重启期间连接会失败，这里容忍并继续轮询。
 * 返回新的 daemon 版本字符串；超时抛错。
 */
export async function waitForRestart(fromVersion: string, timeoutMs = 120000): Promise<string> {
  const start = Date.now();
  // 给旧进程一点时间开始关闭，避免一上来就读到旧版本
  await sleep(3000);
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await client.get('/api/v1/version', { timeout: 4000 });
      const v: string = resp.data?.daemon || resp.data?.version || '';
      if (v && v !== fromVersion) return v;
    } catch {
      // 重启期间的连接失败属预期，继续轮询
    }
    await sleep(2500);
  }
  throw new Error('等待服务重启超时');
}
