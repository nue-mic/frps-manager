import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { readBootstrapBranding, getBranding, type Branding } from '../api/branding';

interface BrandingContextValue {
  branding: Branding;
  /** 设置页保存成功后调用，即时刷新侧边栏 / 登录页 / 标题，无需重登或刷新。 */
  setBrandingLocal: (b: Branding) => void;
}

const BrandingContext = createContext<BrandingContextValue | null>(null);

export function BrandingProvider({ children }: { children: ReactNode }) {
  // 首帧同步取自 daemon 注入的 window.__FRPS_BRANDING__（零闪）。
  const [branding, setBranding] = useState<Branding>(readBootstrapBranding);

  // 运行时校正：dev 环境（vite 无注入）或他端改动后，拉一次公开 GET 同步。
  useEffect(() => {
    let alive = true;
    getBranding()
      .then((b) => {
        if (alive) setBranding(b);
      })
      .catch(() => {
        /* 公开端点，失败时保留 bootstrap/默认值即可 */
      });
    return () => {
      alive = false;
    };
  }, []);

  // 标题随品牌变化保持同步（服务端已注入正确 <title>，此处覆盖运行时编辑场景）。
  useEffect(() => {
    if (branding.html_title) document.title = branding.html_title;
  }, [branding.html_title]);

  const value = useMemo(
    () => ({ branding, setBrandingLocal: setBranding }),
    [branding]
  );

  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding() {
  const ctx = useContext(BrandingContext);
  if (!ctx) throw new Error('useBranding must be used within BrandingProvider');
  return ctx;
}
