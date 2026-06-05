import type { Daemon } from '../fixtures/daemon';
import { minimalServerConfig } from './toml';

/**
 * 直接调 daemon REST API 的 helper. 用于在测试中快速 setup 状态
 * (绕过 UI 加速, UI 自己的交互由 spec 内的 page actions 测).
 */
export function api(daemon: Daemon) {
  const h = { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' };

  return {
    /**
     * 创建一个 frps 配置。bindPort 默认 7000；e2e 多用例并存时显式传递避免端口冲突。
     */
    async createConfig(id: string, name = id, bindPort = 7000) {
      const r = await fetch(`${daemon.baseURL}/api/v1/configs`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({
          id,
          config: minimalServerConfig(bindPort),
          frpmgr: { name, manualStart: true },
        }),
      });
      if (!r.ok) throw new Error(`createConfig(${id}) failed: ${r.status} ${await r.text()}`);
    },

    async start(id: string) {
      const r = await fetch(`${daemon.baseURL}/api/v1/configs/${id}/start`, {
        method: 'POST',
        headers: h,
      });
      if (!r.ok) throw new Error(`start(${id}) failed: ${r.status} ${await r.text()}`);
    },

    async stop(id: string) {
      const r = await fetch(`${daemon.baseURL}/api/v1/configs/${id}/stop`, {
        method: 'POST',
        headers: h,
      });
      if (!r.ok) throw new Error(`stop(${id}) failed: ${r.status} ${await r.text()}`);
    },

    async getStatus(id: string): Promise<{ state: string }> {
      const r = await fetch(`${daemon.baseURL}/api/v1/configs/${id}/status`, { headers: h });
      if (!r.ok) throw new Error(`getStatus(${id}) failed: ${r.status}`);
      return r.json();
    },

    async deleteConfig(id: string) {
      const r = await fetch(`${daemon.baseURL}/api/v1/configs/${id}`, {
        method: 'DELETE',
        headers: h,
      });
      if (!r.ok && r.status !== 404) {
        throw new Error(`deleteConfig(${id}) failed: ${r.status}`);
      }
    },

    /** 轮询 status 直到 state 匹配 want 或超时。 */
    async waitForState(id: string, want: string, timeoutMs = 10000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const s = await this.getStatus(id);
          if (s.state === want) return;
        } catch {
          // ignore
        }
        await new Promise((res) => setTimeout(res, 250));
      }
      throw new Error(`waitForState(${id}, ${want}) timed out`);
    },
  };
}
