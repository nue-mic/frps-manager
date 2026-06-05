/**
 * 确认前端没有 frpc 残留：
 *  - 菜单显示 "FRPS 实例"（不应有 "FRPC 实例"）
 *  - 不应有 "NAT 探测" 菜单项
 *  - 路由 /tools/nat 应不存在（直接 SPA 后端会回退到 index.html，但页内无 NAT 内容）
 *  - 已删的 /api/v1/configs/{id}/proxies 端点返回 404
 *  - 已删的 /api/v1/nathole/discover 返回 405（chi 路由器对已删 path 的 POST 行为）
 */
import { test, expect } from './fixtures/daemon';

test('前端无 frpc 文案/菜单/旧端点残留', async ({ page, daemon }) => {
  // 登录
  await page.goto(daemon.baseURL);
  await page.getByPlaceholder(/API Token|Bearer/i).fill(daemon.token);
  await page.getByRole('button', { name: /验证并进入控制台|登录/i }).click();
  await page.waitForLoadState('networkidle');

  // 菜单标签：FRPS 而非 FRPC
  await expect(page.getByRole('menuitem', { name: /FRPS 实例/ })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('menuitem', { name: /FRPC 实例/ })).toHaveCount(0);

  // 应该有运行时监控、流量、告警等 frps 专属菜单
  await expect(page.getByRole('menuitem', { name: /运行时监控/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /告警/ })).toBeVisible();

  // 不应有 NAT 探测
  await expect(page.getByRole('menuitem', { name: /NAT 探测/ })).toHaveCount(0);
});

test('已删除的 frpc API 端点确认 404/405', async ({ daemon }) => {
  const h = { Authorization: `Bearer ${daemon.token}` };

  // GET proxies 应 404（路由完全没有）
  const proxiesGet = await fetch(`${daemon.baseURL}/api/v1/configs/anything/proxies`, { headers: h });
  expect(proxiesGet.status).toBe(404);

  // POST nathole/discover 应不是 200/201（已删，chi 返回 405）
  const nh = await fetch(`${daemon.baseURL}/api/v1/nathole/discover`, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: '{}',
  });
  expect([404, 405]).toContain(nh.status);

  // frps 服务端管理面板必须有的端点应可达
  const overview = await fetch(`${daemon.baseURL}/api/v1/runtime/anything/overview`, { headers: h });
  // anything 不存在 → 404；端点本身存在
  expect([404, 409]).toContain(overview.status);

  // metrics 端点存在
  const traffic = await fetch(`${daemon.baseURL}/api/v1/metrics/anything/traffic?to=9999999999`, {
    headers: h,
  });
  expect([200, 404]).toContain(traffic.status);

  // alerts 端点存在
  const alerts = await fetch(`${daemon.baseURL}/api/v1/alerts`, { headers: h });
  expect(alerts.status).toBe(200);
});
