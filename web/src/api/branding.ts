import client from './client';

// UI 品牌。字段为 snake_case，逐字对齐后端 internal/api/ui.go 的 brandingResp。
export interface Branding {
  app_name: string;
  app_subtitle: string;
  html_title: string;
}

// 默认值（与后端 manager.Default* 常量一致），仅作前端兜底。
export const DEFAULT_BRANDING: Branding = {
  app_name: 'FRPS Manager',
  app_subtitle: '服务端管理面板',
  html_title: 'FRPS Manager · 服务端管理面板',
};

declare global {
  interface Window {
    // 由 daemon 注入 index.html 的引导脚本，供首帧同步读取实现零闪。
    __FRPS_BRANDING__?: Partial<Branding>;
  }
}

// 同步读取 daemon 注入的引导品牌；缺失（如 vite dev 无注入）则回退默认。
export function readBootstrapBranding(): Branding {
  const b = typeof window !== 'undefined' ? window.__FRPS_BRANDING__ : undefined;
  return {
    app_name: b?.app_name?.trim() || DEFAULT_BRANDING.app_name,
    app_subtitle: b?.app_subtitle?.trim() || DEFAULT_BRANDING.app_subtitle,
    html_title: b?.html_title?.trim() || DEFAULT_BRANDING.html_title,
  };
}

// 读取生效品牌（公开端点，无需 token）。
export async function getBranding(): Promise<Branding> {
  const resp = await client.get<Branding>('/api/v1/ui/branding');
  return resp.data;
}

// 更新品牌（需 token，由请求拦截器自动注入）。省略字段保留原值，空串重置为默认。
export async function updateBranding(payload: Partial<Branding>): Promise<Branding> {
  const resp = await client.put<Branding>('/api/v1/ui/branding', payload);
  return resp.data;
}
