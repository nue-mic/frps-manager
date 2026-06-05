/**
 * frps 实例生命周期端到端：登录 → 看见列表 → API 建配置 → UI 看到卡片 →
 * 点启动 → API 确认 started → 删除 → 卡片消失。
 *
 * 用 API helper 建配置（绕开 UI 复杂 Modal），UI 验证「看到/状态变化/删除」。
 * 这样测试焦点在「前端正确显示后端真实状态」，而非表单细节。
 */
import { test, expect } from './fixtures/daemon';
import { api } from './helpers/api';
import { login, sidebar, configList } from './helpers/selectors';

test('登录 → 建/启/停/删 frps 配置（端到端）', async ({ page, daemon }) => {
  const a = api(daemon);

  // ---- 登录 ----
  await page.goto(daemon.baseURL);
  await login.tokenInput(page).fill(daemon.token);
  await login.submitBtn(page).click();

  // 登录成功后跳到首页/Configs，菜单可见
  await expect(sidebar.frpsInstancesItem(page)).toBeVisible({ timeout: 10000 });

  // 跳到 Configs 页
  await sidebar.frpsInstancesItem(page).click();

  // ---- 用 API 建一个配置 ----
  await a.createConfig('e2e1', '端到端测试 1', 27001);

  // UI 应该收到 WS config.changed 事件 或 主动刷新，看到卡片
  // 给一点时间让前端拉列表
  await expect(configList.configCard(page, 'e2e1')).toBeVisible({ timeout: 10000 });

  // ---- 点卡片内的启动按钮（PlayCircleOutlined） ----
  // 紧凑模式与详细模式的按钮都是同一个 icon 按钮；用 testid 限定到卡片内再点 button
  const card = configList.configCard(page, 'e2e1');
  // 卡片内第一个 button（启动/停止图标按钮）
  await card.locator('button').first().click();

  // ---- API 验证状态机抵达 started ----
  await a.waitForState('e2e1', 'started', 10000);

  // UI 状态文案变成「正在运行」(WS instance.state 事件推送或主动刷新)
  await expect(card.getByText(/正在运行/)).toBeVisible({ timeout: 10000 });

  // ---- 停止 ----
  await a.stop('e2e1');
  await a.waitForState('e2e1', 'stopped', 10000);

  // ---- 删除 ----
  await a.deleteConfig('e2e1');
  // 重载页面确保从 API 取最新列表（订阅 config.deleted 是优化，但 reload 是用户常规行为）
  await page.reload();
  await expect(configList.configCard(page, 'e2e1')).toHaveCount(0, { timeout: 10000 });
});
