import { useEffect, useState } from 'react';
import { Space, Typography, Tooltip } from 'antd';
import {
  TeamOutlined,
  ApiOutlined,
  ArrowDownOutlined,
  ArrowUpOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import client from '../api/client';
import type { RuntimeOverview } from '../api/types';
import { formatBytes } from '../utils/format';

// 实例「实时运行预览」条：实例运行中时，每 5s 拉一次 /runtime/{id}/overview
// （frps 原生 camelCase 透传），展示在线客户端 / 连接数 / 代理数 / 入出站流量。
// 纯只读、全防御：实例未运行或接口失败时静默隐藏，绝不打扰主流程。

interface Props {
  instanceId: string;
  running: boolean;
}

const POLL_MS = 5000;

const InstanceLivePreview: React.FC<Props> = ({ instanceId, running }) => {
  const [ov, setOv] = useState<RuntimeOverview | null>(null);

  useEffect(() => {
    if (!instanceId || !running) {
      setOv(null);
      return;
    }
    // 本地 alive 标志（每次 effect 运行独立捕获），避免旧实例在途请求把数据
    // 写进切换后的新实例预览。
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const resp = await client.get(`/api/v1/runtime/${instanceId}/overview`);
        if (alive) setOv((resp.data as RuntimeOverview) || null);
      } catch {
        // worker 刚起/接口 5xx 都属正常瞬态，保留上次值，不清空、不报错
      } finally {
        if (alive) timer = setTimeout(tick, POLL_MS);
      }
    };
    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [instanceId, running]);

  if (!running || !ov) return null;

  const proxyCount = Object.values(ov.proxyTypeCount ?? {}).reduce((a, b) => a + (b ?? 0), 0);

  const item = (icon: React.ReactNode, label: string, value: React.ReactNode, color?: string) => (
    <Tooltip title={label}>
      <Space size={4} style={{ fontSize: 12 }}>
        <span style={{ color: color || '#8c8c8c' }}>{icon}</span>
        <Typography.Text strong style={{ fontSize: 12 }}>{value}</Typography.Text>
      </Space>
    </Tooltip>
  );

  return (
    <Space size={14} wrap style={{ rowGap: 4 }}>
      <Tooltip title="实时运行预览（每 5 秒刷新）">
        <ThunderboltOutlined style={{ color: '#52c41a' }} />
      </Tooltip>
      {item(<TeamOutlined />, '在线客户端', ov.clientCounts ?? 0, '#1677ff')}
      {item(<ApiOutlined />, '活跃代理', proxyCount, '#722ed1')}
      {item(<ThunderboltOutlined />, '当前连接数', ov.curConns ?? 0, '#fa8c16')}
      {item(<ArrowDownOutlined />, '入站流量', formatBytes(ov.totalTrafficIn), '#52c41a')}
      {item(<ArrowUpOutlined />, '出站流量', formatBytes(ov.totalTrafficOut), '#eb2f96')}
    </Space>
  );
};

export default InstanceLivePreview;
