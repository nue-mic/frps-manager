import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Card,
  Row,
  Col,
  Typography,
  Space,
  Progress,
  Statistic,
  Descriptions,
  Empty,
  Skeleton,
  Tag,
  Table,
  Tooltip,
  theme as antdTheme,
} from 'antd';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip as RTooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import {
  DesktopOutlined,
  CloudServerOutlined,
  ThunderboltOutlined,
  DatabaseOutlined,
  ApiOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import client from '../api/client';
import { fmtDateTime, fmtTime, fmtHourMinute } from '../utils/time';

const { Title, Text } = Typography;

interface SystemInfo {
  uptime_s: number;
  data_dir: string;
  host?: {
    hostname: string;
    os: string;
    platform: string;
    platform_version: string;
    kernel_version: string;
    kernel_arch: string;
    virtualization?: string;
    uptime_seconds: number;
    boot_time: number;
  };
  cpu?: {
    logical_count: number;
    physical_count: number;
    model_name?: string;
    mhz_per_core?: number;
    usage_percent: number;
    per_core?: number[];
    load_avg_1?: number;
    load_avg_5?: number;
    load_avg_15?: number;
  };
  memory?: {
    total: number;
    available: number;
    used: number;
    used_percent: number;
    free: number;
    swap_total: number;
    swap_used: number;
  };
  disk?: Array<{
    path: string;
    fstype?: string;
    total: number;
    used: number;
    free: number;
    used_percent: number;
  }>;
  network?: Array<{
    name: string;
    bytes_sent: number;
    bytes_recv: number;
    packets_sent: number;
    packets_recv: number;
  }>;
  connections?: {
    tcp_total: number;
    udp_total: number;
    tcp_by_status: Record<string, number>;
    owned_tcp_conns: number;
    owned_udp_conns: number;
  };
  process?: {
    pid: number;
    cpu_percent: number;
    rss_bytes: number;
    vms_bytes: number;
    num_threads: number;
    num_goroutines: number;
    open_files?: number;
    start_time: number;
  };
}

interface HistoryPoint {
  t: number;
  cpu: number;
  mem: number;
  rx: number;
  tx: number;
}

const KEEP_HISTORY = 60;

function fmtBytes(n: number): string {
  if (!n || n < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

function fmtRate(bytesPerSec: number): string {
  return `${fmtBytes(bytesPerSec)}/s`;
}

function fmtUptime(seconds: number): string {
  if (!seconds || seconds < 0) return '—';
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}天`);
  if (h > 0) parts.push(`${h}小时`);
  if (m > 0 && d === 0) parts.push(`${m}分`);
  if (parts.length === 0) parts.push(`${s}秒`);
  return parts.join(' ');
}


const SystemPage: React.FC = () => {
  const { token } = antdTheme.useToken();
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const prevNet = useRef<{ ts: number; rx: number; tx: number } | null>(null);

  useEffect(() => {
    let timer: number | undefined;
    let stopped = false;
    const pump = async () => {
      try {
        const resp = await client.get<SystemInfo>('/api/v1/system/info');
        if (stopped) return;
        const data = resp.data;
        setInfo(data);

        const now = Date.now();
        const rxSum = (data.network ?? []).reduce((acc, n) => acc + (n.bytes_recv ?? 0), 0);
        const txSum = (data.network ?? []).reduce((acc, n) => acc + (n.bytes_sent ?? 0), 0);
        let rxRate = 0;
        let txRate = 0;
        if (prevNet.current) {
          const dt = (now - prevNet.current.ts) / 1000;
          if (dt > 0) {
            rxRate = Math.max(0, (rxSum - prevNet.current.rx) / dt);
            txRate = Math.max(0, (txSum - prevNet.current.tx) / dt);
          }
        }
        prevNet.current = { ts: now, rx: rxSum, tx: txSum };

        setHistory((prev) => {
          const next = prev.length >= KEEP_HISTORY ? prev.slice(prev.length - KEEP_HISTORY + 1) : prev.slice();
          next.push({
            t: now,
            cpu: data.cpu?.usage_percent ?? 0,
            mem: data.memory?.used_percent ?? 0,
            rx: rxRate,
            tx: txRate,
          });
          return next;
        });
      } finally {
        if (!stopped) setLoading(false);
      }
    };
    pump();
    timer = window.setInterval(pump, 2500);
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  const diskColumns: ColumnsType<NonNullable<SystemInfo['disk']>[number]> = [
    { title: '路径', dataIndex: 'path', width: 200, ellipsis: true },
    { title: '文件系统', dataIndex: 'fstype', width: 110, render: (v) => v || '—' },
    {
      title: '已用 / 总量',
      width: 200,
      render: (_, row) => `${fmtBytes(row.used)} / ${fmtBytes(row.total)}`,
    },
    {
      title: '使用率',
      dataIndex: 'used_percent',
      render: (v: number) => (
        <Progress
          percent={Math.round(v)}
          size="small"
          status={v > 90 ? 'exception' : v > 75 ? 'active' : 'normal'}
        />
      ),
    },
  ];

  const ifaceColumns: ColumnsType<NonNullable<SystemInfo['network']>[number]> = [
    { title: '接口', dataIndex: 'name', width: 140 },
    { title: '已接收', dataIndex: 'bytes_recv', render: fmtBytes },
    { title: '已发送', dataIndex: 'bytes_sent', render: fmtBytes },
    {
      title: '包数 (rx / tx)',
      render: (_, row) =>
        `${(row.packets_recv ?? 0).toLocaleString()} / ${(row.packets_sent ?? 0).toLocaleString()}`,
    },
  ];

  const tcpByStatus = info?.connections?.tcp_by_status ?? {};

  const chartHeight = 180;
  const chartArea = useMemo(
    () =>
      ({
        primary: token.colorPrimary,
        primaryFill: token.colorPrimary + '33',
        success: token.colorSuccess,
        successFill: token.colorSuccess + '33',
        warning: token.colorWarning,
        warningFill: token.colorWarning + '33',
        error: token.colorError,
        errorFill: token.colorError + '33',
      } as const),
    [token]
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card styles={{ body: { padding: 18 } }} style={{ borderRadius: 10 }}>
        <Space align="center" style={{ justifyContent: 'space-between', width: '100%' }} wrap>
          <Space direction="vertical" size={2}>
            <Title level={4} style={{ margin: 0 }}>
              系统监控
            </Title>
            <Text type="secondary" style={{ fontSize: 13 }}>
              每 2.5s 轮询一次，最近 {KEEP_HISTORY} 个采样点会保留在内存。
            </Text>
          </Space>
          <Space size="middle">
            <Statistic title="服务运行时长" value={fmtUptime(info?.uptime_s ?? 0)} valueStyle={{ fontSize: 16 }} />
            {info?.host && (
              <Statistic
                title="主机已开机"
                value={fmtUptime(info.host.uptime_seconds)}
                valueStyle={{ fontSize: 16 }}
              />
            )}
          </Space>
        </Space>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} md={12} xl={6}>
          <Card title={<Space><ThunderboltOutlined /> CPU 使用率</Space>} styles={{ body: { padding: 16 } }} style={{ borderRadius: 10 }}>
            {loading ? (
              <Skeleton active />
            ) : (
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <Statistic
                  value={info?.cpu?.usage_percent ?? 0}
                  precision={1}
                  suffix="%"
                  valueStyle={{ fontSize: 28, color: token.colorPrimary }}
                />
                <Progress percent={Math.round(info?.cpu?.usage_percent ?? 0)} showInfo={false} />
                <ResponsiveContainer width="100%" height={chartHeight}>
                  <AreaChart data={history}>
                    <defs>
                      <linearGradient id="cpu" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={chartArea.primary} stopOpacity={0.6} />
                        <stop offset="95%" stopColor={chartArea.primary} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={token.colorBorderSecondary} />
                    <XAxis dataKey="t" tickFormatter={(t) => fmtHourMinute(Number(t))} stroke={token.colorTextSecondary} fontSize={11} />
                    <YAxis domain={[0, 100]} stroke={token.colorTextSecondary} fontSize={11} />
                    <RTooltip
                      labelFormatter={(v) => fmtTime(Number(v))}
                      formatter={(v) => `${Number(v ?? 0).toFixed(1)}%`}
                      contentStyle={{ background: token.colorBgElevated, border: 'none' }}
                    />
                    <Area type="monotone" dataKey="cpu" stroke={chartArea.primary} fill="url(#cpu)" />
                  </AreaChart>
                </ResponsiveContainer>
                <Descriptions size="small" column={1} colon={false}>
                  <Descriptions.Item label="物理 / 逻辑">
                    {info?.cpu?.physical_count ?? '—'} / {info?.cpu?.logical_count ?? '—'}
                  </Descriptions.Item>
                  {info?.cpu?.load_avg_1 != null && (
                    <Descriptions.Item label="Load">
                      {info.cpu.load_avg_1.toFixed(2)} / {info.cpu.load_avg_5?.toFixed(2)} /{' '}
                      {info.cpu.load_avg_15?.toFixed(2)}
                    </Descriptions.Item>
                  )}
                </Descriptions>
              </Space>
            )}
          </Card>
        </Col>

        <Col xs={24} md={12} xl={6}>
          <Card title={<Space><DatabaseOutlined /> 内存使用率</Space>} styles={{ body: { padding: 16 } }} style={{ borderRadius: 10 }}>
            {loading ? (
              <Skeleton active />
            ) : (
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <Statistic
                  value={info?.memory?.used_percent ?? 0}
                  precision={1}
                  suffix="%"
                  valueStyle={{ fontSize: 28, color: token.colorSuccess }}
                />
                <Progress percent={Math.round(info?.memory?.used_percent ?? 0)} status="active" showInfo={false} strokeColor={token.colorSuccess} />
                <ResponsiveContainer width="100%" height={chartHeight}>
                  <AreaChart data={history}>
                    <defs>
                      <linearGradient id="mem" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={chartArea.success} stopOpacity={0.6} />
                        <stop offset="95%" stopColor={chartArea.success} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={token.colorBorderSecondary} />
                    <XAxis dataKey="t" tickFormatter={(t) => fmtHourMinute(Number(t))} stroke={token.colorTextSecondary} fontSize={11} />
                    <YAxis domain={[0, 100]} stroke={token.colorTextSecondary} fontSize={11} />
                    <RTooltip
                      labelFormatter={(v) => fmtTime(Number(v))}
                      formatter={(v) => `${Number(v ?? 0).toFixed(1)}%`}
                      contentStyle={{ background: token.colorBgElevated, border: 'none' }}
                    />
                    <Area type="monotone" dataKey="mem" stroke={chartArea.success} fill="url(#mem)" />
                  </AreaChart>
                </ResponsiveContainer>
                <Descriptions size="small" column={1} colon={false}>
                  <Descriptions.Item label="已用 / 总量">
                    {fmtBytes(info?.memory?.used ?? 0)} / {fmtBytes(info?.memory?.total ?? 0)}
                  </Descriptions.Item>
                  <Descriptions.Item label="Swap">
                    {fmtBytes(info?.memory?.swap_used ?? 0)} / {fmtBytes(info?.memory?.swap_total ?? 0)}
                  </Descriptions.Item>
                </Descriptions>
              </Space>
            )}
          </Card>
        </Col>

        <Col xs={24} md={12} xl={6}>
          <Card title={<Space><CloudServerOutlined /> 网络速率</Space>} styles={{ body: { padding: 16 } }} style={{ borderRadius: 10 }}>
            {loading ? (
              <Skeleton active />
            ) : (
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <Row gutter={12}>
                  <Col span={12}>
                    <Statistic
                      title="↓ 接收"
                      value={fmtRate(history[history.length - 1]?.rx ?? 0)}
                      valueStyle={{ fontSize: 16, color: token.colorPrimary }}
                    />
                  </Col>
                  <Col span={12}>
                    <Statistic
                      title="↑ 发送"
                      value={fmtRate(history[history.length - 1]?.tx ?? 0)}
                      valueStyle={{ fontSize: 16, color: token.colorWarning }}
                    />
                  </Col>
                </Row>
                <ResponsiveContainer width="100%" height={chartHeight}>
                  <AreaChart data={history}>
                    <defs>
                      <linearGradient id="rx" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={chartArea.primary} stopOpacity={0.5} />
                        <stop offset="95%" stopColor={chartArea.primary} stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="tx" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={chartArea.warning} stopOpacity={0.5} />
                        <stop offset="95%" stopColor={chartArea.warning} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={token.colorBorderSecondary} />
                    <XAxis dataKey="t" tickFormatter={(t) => fmtHourMinute(Number(t))} stroke={token.colorTextSecondary} fontSize={11} />
                    <YAxis tickFormatter={(v) => fmtBytes(v)} stroke={token.colorTextSecondary} fontSize={11} width={56} />
                    <RTooltip
                      labelFormatter={(v) => fmtTime(Number(v))}
                      formatter={(v, name) => [fmtRate(Number(v ?? 0)), name === 'rx' ? '接收' : '发送']}
                      contentStyle={{ background: token.colorBgElevated, border: 'none' }}
                    />
                    <Area type="monotone" dataKey="rx" stroke={chartArea.primary} fill="url(#rx)" />
                    <Area type="monotone" dataKey="tx" stroke={chartArea.warning} fill="url(#tx)" />
                  </AreaChart>
                </ResponsiveContainer>
              </Space>
            )}
          </Card>
        </Col>

        <Col xs={24} md={12} xl={6}>
          <Card title={<Space><ApiOutlined /> 连接概况</Space>} styles={{ body: { padding: 16 } }} style={{ borderRadius: 10 }}>
            {loading ? (
              <Skeleton active />
            ) : (
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <Row gutter={12}>
                  <Col span={12}>
                    <Statistic title="TCP 总计" value={info?.connections?.tcp_total ?? 0} />
                  </Col>
                  <Col span={12}>
                    <Statistic title="UDP 总计" value={info?.connections?.udp_total ?? 0} />
                  </Col>
                </Row>
                <Row gutter={12}>
                  <Col span={12}>
                    <Statistic title="本进程 TCP" value={info?.connections?.owned_tcp_conns ?? 0} valueStyle={{ color: token.colorPrimary }} />
                  </Col>
                  <Col span={12}>
                    <Statistic title="本进程 UDP" value={info?.connections?.owned_udp_conns ?? 0} valueStyle={{ color: token.colorPrimary }} />
                  </Col>
                </Row>
                <Space wrap size={[8, 8]}>
                  {Object.entries(tcpByStatus).map(([k, v]) => (
                    <Tag key={k} bordered={false}>
                      {k} <Text type="secondary">{v}</Text>
                    </Tag>
                  ))}
                  {Object.keys(tcpByStatus).length === 0 && (
                    <Text type="secondary">暂无 TCP 状态分布</Text>
                  )}
                </Space>
              </Space>
            )}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card title={<Space><DesktopOutlined /> 主机信息</Space>} styles={{ body: { padding: 18 } }} style={{ borderRadius: 10 }}>
            {loading ? (
              <Skeleton active />
            ) : info?.host ? (
              <Descriptions column={{ xs: 1, md: 2 }} size="small" labelStyle={{ width: 120 }}>
                <Descriptions.Item label="主机名">{info.host.hostname}</Descriptions.Item>
                <Descriptions.Item label="平台">
                  {info.host.platform} {info.host.platform_version}
                </Descriptions.Item>
                <Descriptions.Item label="内核">{info.host.kernel_version}</Descriptions.Item>
                <Descriptions.Item label="架构">{info.host.kernel_arch}</Descriptions.Item>
                <Descriptions.Item label="虚拟化">
                  {info.host.virtualization ? <Tag color="blue">{info.host.virtualization}</Tag> : '—'}
                </Descriptions.Item>
                <Descriptions.Item label="启动时间">
                  {fmtDateTime(info.host.boot_time * 1000)}
                </Descriptions.Item>
                <Descriptions.Item label="CPU 型号" span={2}>
                  <Tooltip title={info.cpu?.model_name || ''}>
                    <Text ellipsis style={{ maxWidth: 480 }}>
                      {info.cpu?.model_name || '—'}
                    </Text>
                  </Tooltip>
                </Descriptions.Item>
              </Descriptions>
            ) : (
              <Empty description="主机信息不可用" />
            )}
          </Card>
        </Col>

        <Col xs={24} lg={10}>
          <Card title={<Space><CloudServerOutlined /> 守护进程</Space>} styles={{ body: { padding: 18 } }} style={{ borderRadius: 10 }}>
            {loading ? (
              <Skeleton active />
            ) : info?.process ? (
              <Descriptions column={1} size="small" labelStyle={{ width: 110 }}>
                <Descriptions.Item label="PID">{info.process.pid}</Descriptions.Item>
                <Descriptions.Item label="CPU">{info.process.cpu_percent.toFixed(1)} %</Descriptions.Item>
                <Descriptions.Item label="RSS">{fmtBytes(info.process.rss_bytes)}</Descriptions.Item>
                <Descriptions.Item label="Threads / Goroutines">
                  {info.process.num_threads} / {info.process.num_goroutines}
                </Descriptions.Item>
                {info.process.open_files != null && (
                  <Descriptions.Item label="打开文件数">{info.process.open_files}</Descriptions.Item>
                )}
                <Descriptions.Item label="启动时间">
                  {fmtDateTime(info.process.start_time)}
                </Descriptions.Item>
                <Descriptions.Item label="数据目录">
                  <Text code>{info?.data_dir || '—'}</Text>
                </Descriptions.Item>
              </Descriptions>
            ) : (
              <Empty description="进程信息不可用" />
            )}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title="磁盘" styles={{ body: { padding: 0 } }} style={{ borderRadius: 10 }}>
            <Table
              size="small"
              rowKey="path"
              dataSource={info?.disk ?? []}
              columns={diskColumns}
              pagination={false}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无磁盘数据" /> }}
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="网络接口" styles={{ body: { padding: 0 } }} style={{ borderRadius: 10 }}>
            <Table
              size="small"
              rowKey="name"
              dataSource={info?.network ?? []}
              columns={ifaceColumns}
              pagination={false}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无接口数据" /> }}
            />
          </Card>
        </Col>
      </Row>
    </Space>
  );
};

export default SystemPage;
