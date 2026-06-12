import { useEffect, useState } from 'react';
import { Card, Select, Space, Typography, Empty, App } from 'antd';
import client from '../api/client';
import LogConsole from '../components/LogConsole';

const { Title, Text } = Typography;
const { Option } = Select;

interface ConfigOption {
  id: string;
  name: string;
  state: string;
}

// 实时日志流监控页：选择实例后复用 <LogConsole>（与 Configs 右侧「运行日志」tab
// 同一组件，样式/逻辑完全一致）。多实例各自独立日志，切换实例即重连。
const Logs: React.FC = () => {
  const { message } = App.useApp();
  const [configs, setConfigs] = useState<ConfigOption[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');

  useEffect(() => {
    fetchConfigs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchConfigs = async () => {
    try {
      const resp = await client.get('/api/v1/configs');
      if (resp.status === 200) {
        const items = resp.data?.items || resp.data || [];
        const mapped = await Promise.all(
          items.map(async (item: any) => {
            let state = 'stopped';
            try {
              const stResp = await client.get(`/api/v1/configs/${item.id}/status`);
              state = stResp.data?.state || 'stopped';
            } catch {
              /* ignore */
            }
            return {
              id: item.id,
              name: item.name || item.id,
              state,
            };
          })
        );
        setConfigs(mapped);
        const running = mapped.find((c) => c.state === 'started');
        if (running) setSelectedId(running.id);
        else if (mapped.length > 0) setSelectedId(mapped[0].id);
      }
    } catch {
      message.error('加载实例列表失败');
    }
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <Title level={4} style={{ margin: 0 }}>实时日志流监控</Title>
        <Space>
          <Text type="secondary">选择实例:</Text>
          <Select
            value={selectedId || undefined}
            onChange={setSelectedId}
            style={{ width: 240 }}
            placeholder="选择 FRPS 实例"
          >
            {configs.map((c) => (
              <Option key={c.id} value={c.id}>
                <Space>
                  <span
                    className={c.state === 'started' ? 'status-indicator-running' : 'status-indicator-stopped'}
                    style={{ width: 6, height: 6 }}
                  />
                  {c.name}{c.state === 'started' ? ' (运行中)' : ''}
                </Space>
              </Option>
            ))}
          </Select>
        </Space>
      </div>

      <Card
        styles={{ body: { padding: 16 } }}
        style={{ flex: 1, borderRadius: 10, minHeight: 460 }}
      >
        {selectedId ? (
          <LogConsole instanceId={selectedId} height="calc(100vh - 250px)" />
        ) : (
          <div style={{ height: 360, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Empty description="请先选择一个 FRPS 实例" />
          </div>
        )}
      </Card>
    </div>
  );
};

export default Logs;
