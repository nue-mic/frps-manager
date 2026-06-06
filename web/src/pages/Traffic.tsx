import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Card,
  Row,
  Col,
  Select,
  Space,
  Typography,
  Button,
  Input,
  Empty,
  Alert,
  Spin,
  theme as antdTheme,
  App,
} from 'antd';
import { ReloadOutlined, LineChartOutlined } from '@ant-design/icons';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  Legend,
} from 'recharts';

import client from '../api/client';
import type { Snapshot, TrafficSeries, TrafficPoint } from '../api/types';
import { fmtHourMinute } from '../utils/time';

const { Title, Text } = Typography;

// 人类可读字节格式化（与 Runtime.tsx 保持一致）。
const formatBytes = (n?: number): string => {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  if (n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v : v.toFixed(2)} ${units[i]}`;
};

// 时间范围预设：label → { 秒数, 采样步长(秒) }。
const RANGES: { value: string; label: string; rangeSec: number; step: number }[] = [
  { value: '1h', label: '最近 1 小时', rangeSec: 3600, step: 60 },
  { value: '6h', label: '最近 6 小时', rangeSec: 6 * 3600, step: 300 },
  { value: '24h', label: '最近 24 小时', rangeSec: 24 * 3600, step: 300 },
];

interface ChartRow {
  ts: number;
  time: string;
  in: number;
  out: number;
  conns: number;
}

const fmtTime = (unixSec: number): string => fmtHourMinute(unixSec * 1000);

const Traffic: React.FC = () => {
  const { token } = antdTheme.useToken();
  const { message } = App.useApp();

  const [configs, setConfigs] = useState<Snapshot[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [scope, setScope] = useState<'server' | 'proxy'>('server');
  const [proxyKey, setProxyKey] = useState<string>('');
  const [rangeVal, setRangeVal] = useState<string>('1h');

  const [series, setSeries] = useState<TrafficSeries | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  // metrics 关闭（503）时给出明确提示。
  const [disabled, setDisabled] = useState<boolean>(false);

  // 拉取实例列表初始化选择器。
  const fetchConfigs = useCallback(async () => {
    try {
      const resp = await client.get('/api/v1/configs');
      const items: Snapshot[] = resp.data?.items || [];
      setConfigs(items);
      setSelectedId((prev) => {
        if (prev && items.some((c) => c.id === prev)) return prev;
        const firstRunning = items.find((c) => c.state === 'started');
        return firstRunning ? firstRunning.id : (items[0]?.id ?? '');
      });
    } catch {
      message.error('无法获取实例列表');
    }
  }, [message]);

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

  const loadTraffic = useCallback(async () => {
    if (!selectedId) return;
    const preset = RANGES.find((r) => r.value === rangeVal) ?? RANGES[0];
    const to = Math.floor(Date.now() / 1000);
    const from = to - preset.rangeSec;
    setLoading(true);
    setDisabled(false);
    try {
      const resp = await client.get(`/api/v1/metrics/${selectedId}/traffic`, {
        params: {
          scope,
          key: scope === 'proxy' ? proxyKey : '',
          from,
          to,
          step: preset.step,
        },
      });
      setSeries(resp.data as TrafficSeries);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 503) {
        setDisabled(true);
        setSeries(null);
      } else {
        message.error(
          '获取历史流量失败: ' +
            (err?.response?.data?.error?.message || err?.message || '')
        );
      }
    } finally {
      setLoading(false);
    }
  }, [selectedId, scope, proxyKey, rangeVal, message]);

  // 选中实例 / scope / 范围变化后自动查询（proxy 模式需有 key 才查）。
  useEffect(() => {
    if (!selectedId) {
      setSeries(null);
      return;
    }
    if (scope === 'proxy' && !proxyKey.trim()) {
      setSeries(null);
      return;
    }
    loadTraffic();
  }, [selectedId, scope, rangeVal, proxyKey, loadTraffic]);

  const chartData: ChartRow[] = useMemo(() => {
    const pts: TrafficPoint[] = series?.points ?? [];
    return pts.map((p) => ({
      ts: p.ts,
      time: fmtTime(p.ts),
      in: p.in ?? 0,
      out: p.out ?? 0,
      conns: p.conns ?? 0,
    }));
  }, [series]);

  const totals = useMemo(() => {
    return chartData.reduce(
      (acc, r) => {
        acc.in += r.in;
        acc.out += r.out;
        acc.maxConns = Math.max(acc.maxConns, r.conns);
        return acc;
      },
      { in: 0, out: 0, maxConns: 0 }
    );
  }, [chartData]);

  const selectOptions = configs.map((c) => ({
    value: c.id,
    label: (
      <Space size={6}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            display: 'inline-block',
            background:
              c.state === 'started'
                ? token.colorSuccess
                : c.state === 'starting' || c.state === 'stopping'
                ? token.colorWarning
                : token.colorTextDisabled,
          }}
        />
        <span>{c.name || c.id}</span>
        <Text type="secondary" style={{ fontSize: 12 }}>
          ({c.id})
        </Text>
      </Space>
    ),
  }));

  const hasData = chartData.length > 0;

  // recharts Tooltip 的字节格式化。
  const bytesTooltip = (value: number, name: string) => {
    if (name === '连接数') return [value, name];
    return [formatBytes(value), name];
  };

  return (
    <div style={{ height: '100%' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <Space size={12} align="center" wrap>
          <Title level={4} style={{ margin: 0 }}>
            历史流量
          </Title>
          <Select
            style={{ minWidth: 240 }}
            placeholder="选择一个 frps 实例"
            value={selectedId || undefined}
            onChange={setSelectedId}
            options={selectOptions}
            notFoundContent={
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无实例" />
            }
          />
          <Select
            style={{ width: 120 }}
            value={scope}
            onChange={(v) => setScope(v)}
            options={[
              { value: 'server', label: '服务端' },
              { value: 'proxy', label: '代理' },
            ]}
          />
          {scope === 'proxy' && (
            <Input
              style={{ width: 180 }}
              placeholder="代理名 (key)"
              value={proxyKey}
              allowClear
              onChange={(e) => setProxyKey(e.target.value)}
              onPressEnter={() => loadTraffic()}
            />
          )}
          <Select
            style={{ width: 150 }}
            value={rangeVal}
            onChange={setRangeVal}
            options={RANGES.map((r) => ({ value: r.value, label: r.label }))}
          />
        </Space>
        <Button
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={() => loadTraffic()}
          disabled={!selectedId || (scope === 'proxy' && !proxyKey.trim())}
        >
          查询
        </Button>
      </div>

      {!selectedId ? (
        <Card style={{ padding: '80px 0', borderRadius: 10 }}>
          <Empty description="请先在上方选择一个 frps 实例。" />
        </Card>
      ) : disabled ? (
        <Alert
          type="warning"
          showIcon
          message="历史指标采集已关闭"
          description="后端 metrics 存储未启用（返回 503），无法查询历史流量。"
        />
      ) : scope === 'proxy' && !proxyKey.trim() ? (
        <Card style={{ padding: '60px 0', borderRadius: 10 }}>
          <Empty description="请输入要查询的代理名（key）。" />
        </Card>
      ) : (
        <Spin spinning={loading}>
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Row gutter={[16, 16]}>
              <Col xs={24} sm={8}>
                <Card bordered={false} style={{ borderRadius: 10 }}>
                  <Text type="secondary">区间累计入站</Text>
                  <div>
                    <Text strong style={{ fontSize: 20 }}>
                      {formatBytes(totals.in)}
                    </Text>
                  </div>
                </Card>
              </Col>
              <Col xs={24} sm={8}>
                <Card bordered={false} style={{ borderRadius: 10 }}>
                  <Text type="secondary">区间累计出站</Text>
                  <div>
                    <Text strong style={{ fontSize: 20 }}>
                      {formatBytes(totals.out)}
                    </Text>
                  </div>
                </Card>
              </Col>
              <Col xs={24} sm={8}>
                <Card bordered={false} style={{ borderRadius: 10 }}>
                  <Text type="secondary">峰值连接数</Text>
                  <div>
                    <Text strong style={{ fontSize: 20 }}>
                      {totals.maxConns}
                    </Text>
                  </div>
                </Card>
              </Col>
            </Row>

            <Card
              title="入站 / 出站流量（每桶增量）"
              bordered={false}
              style={{ borderRadius: 10 }}
            >
              {hasData ? (
                <div style={{ width: '100%', height: 320 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={token.colorBorderSecondary} />
                      <XAxis dataKey="time" tick={{ fontSize: 12 }} minTickGap={24} />
                      <YAxis
                        tick={{ fontSize: 12 }}
                        tickFormatter={(v: number) => formatBytes(v)}
                        width={72}
                      />
                      <RTooltip formatter={bytesTooltip as any} />
                      <Legend />
                      <Line
                        type="monotone"
                        dataKey="in"
                        name="入站"
                        stroke={token.colorSuccess}
                        dot={false}
                        strokeWidth={2}
                      />
                      <Line
                        type="monotone"
                        dataKey="out"
                        name="出站"
                        stroke={token.colorWarning}
                        dot={false}
                        strokeWidth={2}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="该时间范围内暂无流量采样数据"
                />
              )}
            </Card>

            <Card title="连接数（每桶峰值）" bordered={false} style={{ borderRadius: 10 }}>
              {hasData ? (
                <div style={{ width: '100%', height: 260 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={token.colorBorderSecondary} />
                      <XAxis dataKey="time" tick={{ fontSize: 12 }} minTickGap={24} />
                      <YAxis tick={{ fontSize: 12 }} allowDecimals={false} width={48} />
                      <RTooltip />
                      <Legend />
                      <Line
                        type="monotone"
                        dataKey="conns"
                        name="连接数"
                        stroke={token.colorPrimary}
                        dot={false}
                        strokeWidth={2}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="该时间范围内暂无连接数据"
                />
              )}
            </Card>

            <Alert
              type="info"
              showIcon
              banner
              icon={<LineChartOutlined />}
              message="流量曲线来自后端 metrics 存储的降采样历史数据；入/出为每个时间桶内的增量字节数，连接数为桶内瞬时峰值。"
            />
          </Space>
        </Spin>
      )}
    </div>
  );
};

export default Traffic;
