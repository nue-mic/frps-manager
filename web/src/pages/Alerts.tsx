import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Card,
  Table,
  Button,
  Space,
  Typography,
  Tag,
  Switch,
  Modal,
  Form,
  Input,
  Select,
  InputNumber,
  Popconfirm,
  Empty,
  Alert,
  Tooltip,
  theme as antdTheme,
  App,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  PlusOutlined,
  ReloadOutlined,
  EditOutlined,
  DeleteOutlined,
  BellOutlined,
} from '@ant-design/icons';

import client from '../api/client';
import type { Snapshot, AlertRule, AlertEvent } from '../api/types';
import { fmtDateTime } from '../utils/time';

const { Title, Text } = Typography;

const METRIC_OPTS = [
  { value: 'conns', label: '连接数 (conns)' },
  { value: 'traffic_in_rate', label: '入站速率 (traffic_in_rate)' },
  { value: 'traffic_out_rate', label: '出站速率 (traffic_out_rate)' },
];
const OP_OPTS = [
  { value: '>', label: '>' },
  { value: '>=', label: '>=' },
  { value: '<', label: '<' },
  { value: '<=', label: '<=' },
];

const metricLabel = (m: string) =>
  METRIC_OPTS.find((o) => o.value === m)?.label ?? m;

const fmtUnixSec = (s?: number): string => {
  if (!s) return '—';
  return fmtDateTime(s * 1000);
};

// 表单字段严格对应 AlertRule（snake_case：inst_id / for_seconds）。
interface RuleFormValues {
  name: string;
  enabled: boolean;
  inst_id: string;
  metric: AlertRule['metric'];
  op: AlertRule['op'];
  threshold: number;
  for_seconds: number;
  target: string;
  webhook: string;
}

const Alerts: React.FC = () => {
  const { token } = antdTheme.useToken();
  const { message } = App.useApp();
  const [form] = Form.useForm<RuleFormValues>();

  const [configs, setConfigs] = useState<Snapshot[]>([]);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [loadingRules, setLoadingRules] = useState<boolean>(false);
  const [loadingEvents, setLoadingEvents] = useState<boolean>(false);
  const [disabled, setDisabled] = useState<boolean>(false);

  const [eventState, setEventState] = useState<string>('');

  const [modalOpen, setModalOpen] = useState<boolean>(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);

  const fetchConfigs = useCallback(async () => {
    try {
      const resp = await client.get('/api/v1/configs');
      setConfigs(resp.data?.items || []);
    } catch {
      // 实例列表仅用于下拉提示，失败不阻断。
    }
  }, []);

  const loadRules = useCallback(async () => {
    setLoadingRules(true);
    setDisabled(false);
    try {
      const resp = await client.get('/api/v1/alerts');
      setRules(resp.data?.items || []);
    } catch (err: any) {
      if (err?.response?.status === 503) {
        setDisabled(true);
        setRules([]);
      } else {
        message.error('获取告警规则失败');
      }
    } finally {
      setLoadingRules(false);
    }
  }, [message]);

  const loadEvents = useCallback(
    async (state: string) => {
      setLoadingEvents(true);
      try {
        const resp = await client.get('/api/v1/alerts/events', {
          params: state ? { state } : {},
        });
        setEvents(resp.data?.items || []);
      } catch (err: any) {
        if (err?.response?.status !== 503) {
          message.error('获取触发历史失败');
        }
        setEvents([]);
      } finally {
        setLoadingEvents(false);
      }
    },
    [message]
  );

  useEffect(() => {
    fetchConfigs();
    loadRules();
  }, [fetchConfigs, loadRules]);

  useEffect(() => {
    loadEvents(eventState);
  }, [eventState, loadEvents]);

  const openCreate = () => {
    setEditingId(null);
    form.resetFields();
    form.setFieldsValue({
      enabled: true,
      inst_id: '*',
      metric: 'conns',
      op: '>',
      threshold: 0,
      for_seconds: 0,
      target: '',
      webhook: '',
    });
    setModalOpen(true);
  };

  const openEdit = (rule: AlertRule) => {
    setEditingId(rule.id);
    form.setFieldsValue({
      name: rule.name,
      enabled: rule.enabled,
      inst_id: rule.inst_id,
      metric: rule.metric,
      op: rule.op,
      threshold: rule.threshold,
      for_seconds: rule.for_seconds,
      target: rule.target,
      webhook: rule.webhook,
    });
    setModalOpen(true);
  };

  const submit = async () => {
    let values: RuleFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    // 请求体逐字按 AlertRule（snake_case）。
    const payload: Omit<AlertRule, 'id'> & { id?: string } = {
      name: values.name,
      enabled: values.enabled ?? true,
      inst_id: values.inst_id || '*',
      metric: values.metric,
      op: values.op,
      threshold: values.threshold ?? 0,
      for_seconds: values.for_seconds ?? 0,
      target: values.target || '',
      webhook: values.webhook || '',
    };
    setSaving(true);
    try {
      if (editingId) {
        await client.put(`/api/v1/alerts/${editingId}`, { ...payload, id: editingId });
        message.success('规则已更新');
      } else {
        await client.post('/api/v1/alerts', payload);
        message.success('规则已创建');
      }
      setModalOpen(false);
      loadRules();
    } catch (err: any) {
      message.error(
        '保存失败: ' + (err?.response?.data?.error?.message || err?.message || '')
      );
    } finally {
      setSaving(false);
    }
  };

  const removeRule = async (id: string) => {
    try {
      await client.delete(`/api/v1/alerts/${id}`);
      message.success('规则已删除');
      loadRules();
    } catch (err: any) {
      message.error(
        '删除失败: ' + (err?.response?.data?.error?.message || err?.message || '')
      );
    }
  };

  // 行内启用/停用开关：PUT 整条规则，仅改 enabled。
  const toggleEnabled = async (rule: AlertRule, enabled: boolean) => {
    try {
      await client.put(`/api/v1/alerts/${rule.id}`, { ...rule, enabled });
      setRules((prev) =>
        prev.map((r) => (r.id === rule.id ? { ...r, enabled } : r))
      );
    } catch (err: any) {
      message.error(
        '更新失败: ' + (err?.response?.data?.error?.message || err?.message || '')
      );
      loadRules();
    }
  };

  const instLabel = useMemo(() => {
    const map = new Map<string, string>();
    configs.forEach((c) => map.set(c.id, c.name || c.id));
    return (id: string) => {
      if (id === '*' || id === '') return '全部实例';
      return map.get(id) || id;
    };
  }, [configs]);

  const ruleColumns: ColumnsType<AlertRule> = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      render: (v: string) => <Text strong>{v}</Text>,
    },
    {
      title: '实例',
      dataIndex: 'inst_id',
      key: 'inst_id',
      render: (v: string) => instLabel(v),
    },
    {
      title: '指标',
      dataIndex: 'metric',
      key: 'metric',
      render: (v: string) => <Tag color="geekblue">{metricLabel(v)}</Tag>,
    },
    {
      title: '条件',
      key: 'cond',
      render: (_, r) => (
        <Text code>
          {r.op} {r.threshold}
        </Text>
      ),
    },
    {
      title: '持续(秒)',
      dataIndex: 'for_seconds',
      key: 'for_seconds',
      align: 'right',
      render: (v: number) => v ?? 0,
    },
    {
      title: '目标',
      dataIndex: 'target',
      key: 'target',
      render: (v: string) => (v && v !== '*' ? <Tag>{v}</Tag> : <Text type="secondary">server</Text>),
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      key: 'enabled',
      align: 'center',
      render: (v: boolean, r) => (
        <Switch
          size="small"
          checked={v}
          onChange={(checked) => toggleEnabled(r, checked)}
        />
      ),
    },
    {
      title: '操作',
      key: 'actions',
      align: 'right',
      render: (_, r) => (
        <Space size={4}>
          <Tooltip title="编辑">
            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
          </Tooltip>
          <Popconfirm
            title="删除该规则？"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => removeRule(r.id)}
          >
            <Button type="text" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const eventColumns: ColumnsType<AlertEvent> = [
    {
      title: '规则',
      dataIndex: 'rule_id',
      key: 'rule_id',
      render: (v: string) => {
        const rule = rules.find((r) => r.id === v);
        return rule ? <Text>{rule.name}</Text> : <Text code style={{ fontSize: 12 }}>{v}</Text>;
      },
    },
    {
      title: '实例',
      dataIndex: 'inst_id',
      key: 'inst_id',
      render: (v: string) => instLabel(v),
    },
    {
      title: '目标',
      dataIndex: 'target',
      key: 'target',
      render: (v: string) => (v && v !== '*' ? <Tag>{v}</Tag> : <Text type="secondary">server</Text>),
    },
    {
      title: '状态',
      dataIndex: 'state',
      key: 'state',
      render: (v: string) =>
        v === 'firing' ? (
          <Tag color="error">触发中</Tag>
        ) : (
          <Tag color="success">已解除</Tag>
        ),
    },
    {
      title: '触发值',
      dataIndex: 'value',
      key: 'value',
      align: 'right',
      render: (v: number) => (v ?? 0),
    },
    {
      title: '触发时间',
      dataIndex: 'fired_at',
      key: 'fired_at',
      render: (v: number) => fmtUnixSec(v),
    },
    {
      title: '解除时间',
      dataIndex: 'resolved_at',
      key: 'resolved_at',
      render: (v: number) => (v ? fmtUnixSec(v) : <Text type="secondary">—</Text>),
    },
  ];

  const instSelectOptions = [
    { value: '*', label: '全部实例 (*)' },
    ...configs.map((c) => ({ value: c.id, label: `${c.name || c.id} (${c.id})` })),
  ];

  if (disabled) {
    return (
      <div>
        <Title level={4} style={{ marginTop: 0 }}>
          告警
        </Title>
        <Alert
          type="warning"
          showIcon
          message="告警功能已关闭"
          description="后端 metrics 存储未启用（返回 503），无法管理告警规则与事件。"
        />
      </div>
    );
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <Space size={12} align="center">
          <Title level={4} style={{ margin: 0 }}>
            告警
          </Title>
          <Text type="secondary" style={{ fontSize: 13 }}>
            <BellOutlined style={{ color: token.colorPrimary }} /> 规则触发后可选 webhook 通知
          </Text>
        </Space>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={loadRules} loading={loadingRules}>
            刷新
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新建规则
          </Button>
        </Space>
      </div>

      <Card title="告警规则" bordered={false} style={{ borderRadius: 10 }}>
        <Table<AlertRule>
          size="small"
          rowKey="id"
          columns={ruleColumns}
          dataSource={rules}
          loading={loadingRules}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          locale={{
            emptyText: (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无告警规则" />
            ),
          }}
        />
      </Card>

      <Card
        title="触发历史"
        bordered={false}
        style={{ borderRadius: 10 }}
        extra={
          <Select
            size="small"
            style={{ width: 140 }}
            value={eventState}
            onChange={setEventState}
            options={[
              { value: '', label: '全部状态' },
              { value: 'firing', label: '触发中' },
              { value: 'resolved', label: '已解除' },
            ]}
          />
        }
      >
        <Table<AlertEvent>
          size="small"
          rowKey="id"
          columns={eventColumns}
          dataSource={events}
          loading={loadingEvents}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          locale={{
            emptyText: (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无触发记录" />
            ),
          }}
        />
      </Card>

      <Modal
        title={editingId ? '编辑告警规则' : '新建告警规则'}
        open={modalOpen}
        onOk={submit}
        confirmLoading={saving}
        onCancel={() => setModalOpen(false)}
        okText="保存"
        cancelText="取消"
        destroyOnClose
        width={560}
      >
        <Form form={form} layout="vertical" requiredMark="optional">
          <Form.Item
            label="规则名称"
            name="name"
            rules={[{ required: true, message: '请输入规则名称' }]}
          >
            <Input placeholder="如：连接数过高告警" />
          </Form.Item>

          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item
              label="监控指标"
              name="metric"
              rules={[{ required: true, message: '请选择指标' }]}
              style={{ flex: 1 }}
            >
              <Select options={METRIC_OPTS} />
            </Form.Item>
            <Form.Item
              label="比较符"
              name="op"
              rules={[{ required: true, message: '请选择比较符' }]}
              style={{ width: 110 }}
            >
              <Select options={OP_OPTS} />
            </Form.Item>
            <Form.Item
              label="阈值"
              name="threshold"
              rules={[{ required: true, message: '请输入阈值' }]}
              style={{ width: 140 }}
            >
              <InputNumber style={{ width: '100%' }} min={0} />
            </Form.Item>
          </Space>

          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item label="目标实例" name="inst_id" style={{ flex: 1 }}>
              <Select
                showSearch
                optionFilterProp="label"
                options={instSelectOptions}
                placeholder="* 表示全部实例"
              />
            </Form.Item>
            <Form.Item
              label="持续时间(秒)"
              name="for_seconds"
              style={{ width: 160 }}
              tooltip="条件需连续满足这么久才触发（去抖），0 表示立即"
            >
              <InputNumber style={{ width: '100%' }} min={0} />
            </Form.Item>
          </Space>

          <Form.Item
            label="代理名 (target)"
            name="target"
            tooltip="留空或 * 表示 server 级，否则填具体代理名"
          >
            <Input placeholder="留空 = server 级" allowClear />
          </Form.Item>

          <Form.Item
            label="Webhook URL"
            name="webhook"
            tooltip="可选；触发/解除时向该地址 POST 通知"
          >
            <Input placeholder="https://... (可选)" allowClear />
          </Form.Item>

          <Form.Item label="启用" name="enabled" valuePropName="checked">
            <Switch checkedChildren="启用" unCheckedChildren="停用" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
};

export default Alerts;
