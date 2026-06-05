import type { Page, Locator } from '@playwright/test';

export const login = {
  // Input.Password with placeholder="API Token (Bearer 令牌)"
  tokenInput: (p: Page): Locator => p.getByPlaceholder(/API Token|Bearer/i),
  submitBtn: (p: Page): Locator =>
    p.getByRole('button', { name: /验证并进入控制台|登录|login|sign in/i }),
  errorMsg: (p: Page): Locator => p.getByText(/无效|invalid|失败|failed/i),
};

export const sidebar = {
  // 菜单已从 frpc 转为 frps —— 选择器同步更新
  frpsInstancesItem: (p: Page): Locator =>
    p.getByRole('menuitem', { name: /FRPS 实例|实例/i }),
  runtimeItem: (p: Page): Locator =>
    p.getByRole('menuitem', { name: /运行时监控|runtime/i }),
  dashboardItem: (p: Page): Locator =>
    p.getByRole('menuitem', { name: /仪表盘|dashboard/i }),
};

export const configList = {
  // 卡片用 data-testid="config-card-{id}"，Configs.tsx 中保留
  configCard: (p: Page, id: string): Locator =>
    p.locator(`[data-testid="config-card-${id}"]`),
  // 卡片内的状态徽章文案
  statusText: (card: Locator): Locator =>
    card.locator('.ant-badge-status-text, span', { hasText: /运行中|未启动|启动中|停止中/ }).first(),
};
