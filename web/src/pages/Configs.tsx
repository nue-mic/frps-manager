import { useEffect, useState, useRef } from 'react';
import {
  Card, Row, Col, Button, Badge, Space, Typography, Popconfirm,
  Tabs, Form, Input, InputNumber, Switch, Modal,
  message, Tag, Tooltip, Empty, List, Dropdown,
  theme as antdTheme,
} from 'antd';
import type { MenuProps } from 'antd';
import {
  PlayCircleOutlined,
  StopOutlined,
  ReloadOutlined,
  DeleteOutlined,
  CopyOutlined,
  EditOutlined,
  CodeOutlined,
  PlusOutlined,
  CheckCircleOutlined,
  DownloadOutlined,
  ExclamationCircleOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  FileTextOutlined,
} from '@ant-design/icons';

const LIST_COMPACT_KEY = 'frpsmgr_configs_compact';
import CodeMirror from '@uiw/react-codemirror';
import { StreamLanguage } from '@codemirror/language';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';

// 与 VS Code 默认 monospace 字体栈对齐。
const VSCODE_MONO = `'Cascadia Code', 'Cascadia Mono', Consolas, 'SF Mono', Menlo, Monaco, 'Roboto Mono', 'Fira Code', 'JetBrains Mono', 'Source Code Pro', 'Liberation Mono', 'Courier New', monospace`;

const tomlEditorFontTheme = EditorView.theme({
  '&': { fontFamily: VSCODE_MONO, fontSize: '13.5px' },
  '.cm-content': { fontFamily: VSCODE_MONO, fontVariantLigatures: 'contextual', caretColor: '#fff' },
  '.cm-gutters': { fontFamily: VSCODE_MONO, fontSize: '12.5px' },
  '.cm-scroller': { lineHeight: '1.55' },
});

import client from '../api/client';
import { useTheme } from '../theme/ThemeContext';
import { useEventSubscription } from '../events/EventStreamContext';
import type { InstanceStateData } from '../events/types';
import type { Snapshot, ServerConfig, MgrMeta, ConfigEnvelope, WebServerInfo } from '../api/types';
import {
  buildServerConfigPayload,
  flattenServerConfig,
  mergeServerConfig,
  type ServerFullFormValues,
} from './serverConfigForm';
import ServerConfigGroups from './ServerConfigGroups';
import LogConsole from '../components/LogConsole';
import InstanceLivePreview from '../components/InstanceLivePreview';

const { Title, Text } = Typography;

// 可视化表单顶层值：实例元数据 + 扁平化的全部 frps 字段。
// 扁平字段定义见 ./serverConfigForm.ts（提交时由 buildServerConfigPayload 折叠回嵌套对象）。
interface ServerFormValues extends ServerFullFormValues {
  name?: string;
  manualStart?: boolean;
}

interface NewConfigValues {
  id: string;
  name?: string;
  bindAddr?: string;
  bindPort?: number;
  authToken?: string;
  manualStart?: boolean;
}

const Configs: React.FC = () => {
  const { token } = antdTheme.useToken();
  const { resolved: themeMode } = useTheme();
  const tomlExtensions = [StreamLanguage.define(toml), tomlEditorFontTheme];

  const [configs, setConfigs] = useState<Snapshot[]>([]);
  const [activeConfigId, setActiveConfigId] = useState<string>('');
  const [statusLoading, setStatusLoading] = useState<Record<string, boolean>>({});

  // 选项卡：常规配置（可视化）/ 高级 TOML / 运行日志
  const [activeTab, setActiveTab] = useState<string>('visual');

  // 当前配置信封（用于保存时透传 config 的未知字段）
  const [detailEnvelope, setDetailEnvelope] = useState<ConfigEnvelope | null>(null);
  const [rawToml, setRawToml] = useState<string>('');
  const [tomlLoading, setTomlLoading] = useState<boolean>(false);

  // 运行日志改用可复用的 <LogConsole>（自包含 WS 实时尾追 + 过滤 + 级别筛选 +
  // 复制 + 清空/重连），此处不再维护迷你日志状态。

  // 新建配置 Modal
  const [newConfigModalOpen, setNewConfigModalOpen] = useState<boolean>(false);

  // 左栏紧凑模式
  const [compactList, setCompactList] = useState<boolean>(
    () => localStorage.getItem(LIST_COMPACT_KEY) === '1'
  );
  const toggleCompactList = () => {
    setCompactList((prev) => {
      const next = !prev;
      localStorage.setItem(LIST_COMPACT_KEY, next ? '1' : '0');
      return next;
    });
  };

  const [form] = Form.useForm<ServerFormValues>();
  const [newConfigForm] = Form.useForm<NewConfigValues>();

  useEffect(() => {
    fetchConfigs();
  }, []);

  useEffect(() => {
    if (activeConfigId) {
      handleLoadConfigDetails(activeConfigId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConfigId, activeTab]);

  const fetchConfigs = async () => {
    try {
      const resp = await client.get('/api/v1/configs');
      if (resp.status === 200) {
        const items: Snapshot[] = resp.data?.items || [];
        setConfigs(items);
        if (items.length > 0 && !activeConfigId) {
          setActiveConfigId(items[0].id);
        }
      }
    } catch {
      message.error('无法获取配置列表');
    }
  };

  const fetchStatus = async (id: string) => {
    try {
      const resp = await client.get(`/api/v1/configs/${id}/status`);
      if (resp.status === 200) {
        const snap = resp.data as Snapshot;
        setConfigs(prev => prev.map(c => (c.id === id ? { ...c, ...snap } : c)));
      }
    } catch {
      // 忽略状态请求错误
    }
  };

  // 实时同步配置引用，规避闭包陷阱
  const configsRef = useRef(configs);
  useEffect(() => {
    configsRef.current = configs;
  }, [configs]);

  // 轮询状态（每 4 秒）
  useEffect(() => {
    if (configsRef.current && configsRef.current.length > 0) {
      configsRef.current.forEach(c => fetchStatus(c.id));
    }
    const timer = setInterval(() => {
      if (configsRef.current && configsRef.current.length > 0) {
        configsRef.current.forEach(c => fetchStatus(c.id));
      }
    }, 4000);
    return () => clearInterval(timer);
  }, []);

  // 事件驱动：实例启停/配置变更/删除时实时刷新列表
  useEventSubscription(['config.changed', 'config.deleted', 'instance.state'], (e) => {
    if (e.type === 'instance.state' && e.config_id) {
      const st = (e.data as InstanceStateData | undefined)?.state;
      if (st) {
        setConfigs(prev => prev.map(c => (c.id === e.config_id ? { ...c, state: st as Snapshot['state'] } : c)));
      }
    } else if (e.type === 'config.deleted' && e.config_id) {
      // 删除事件：直接从列表移除，避免必须刷页面才反映
      setConfigs(prev => prev.filter(c => c.id !== e.config_id));
      setActiveConfigId(prev => (prev === e.config_id ? '' : prev));
    } else if (e.type === 'config.changed') {
      // 创建/更新事件：拉一次列表保持同步
      fetchConfigs();
    }
  });

  const handleStartInstance = async (id: string) => {
    setStatusLoading(prev => ({ ...prev, [id]: true }));
    try {
      await client.post(`/api/v1/configs/${id}/start`);
      message.success('启动指令已发送');
      fetchStatus(id);
    } catch (err: any) {
      message.error('启动失败: ' + (err.response?.data?.error?.message || err.message));
    } finally {
      setStatusLoading(prev => ({ ...prev, [id]: false }));
    }
  };

  const handleStopInstance = async (id: string) => {
    setStatusLoading(prev => ({ ...prev, [id]: true }));
    try {
      await client.post(`/api/v1/configs/${id}/stop`);
      message.success('停止指令已发送');
      fetchStatus(id);
    } catch (err: any) {
      message.error('停止失败: ' + (err.response?.data?.error?.message || err.message));
    } finally {
      setStatusLoading(prev => ({ ...prev, [id]: false }));
    }
  };

  // reload = 重启（frps 子进程不支持热重载，后端会停后再起）
  const handleReloadInstance = async (id: string) => {
    setStatusLoading(prev => ({ ...prev, [id]: true }));
    try {
      await client.post(`/api/v1/configs/${id}/reload`);
      message.success('已重启实例');
      fetchStatus(id);
    } catch (err: any) {
      message.error('重启失败: ' + (err.response?.data?.error?.message || err.message));
    } finally {
      setStatusLoading(prev => ({ ...prev, [id]: false }));
    }
  };

  const handleDeleteConfig = async (id: string) => {
    try {
      await client.delete(`/api/v1/configs/${id}`);
      message.success('配置已删除');
      if (activeConfigId === id) {
        setActiveConfigId('');
        setDetailEnvelope(null);
      }
      fetchConfigs();
    } catch {
      message.error('删除配置失败');
    }
  };

  const handleDuplicateConfig = async (id: string) => {
    const newId = `${id}_copy`;
    try {
      await client.post(`/api/v1/configs/${id}/duplicate`, { new_id: newId });
      message.success(`已复制为新配置: ${newId}`);
      fetchConfigs();
    } catch (err: any) {
      message.error('复制失败: ' + (err.response?.data?.error?.message || err.message));
    }
  };

  // 导出单个配置为 TOML 文件
  const handleExportConfig = async (id: string) => {
    try {
      const resp = await client.get(`/api/v1/configs/${id}/export`, { responseType: 'blob' });
      const blob = new Blob([resp.data], { type: 'application/toml' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${id}.toml`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
      message.success(`已导出 ${id}.toml`);
    } catch (err: any) {
      message.error('导出失败: ' + (err.response?.data?.error?.message || err.message));
    }
  };

  // 右键菜单
  const buildContextMenu = (item: Snapshot): MenuProps => {
    const isRunning = item.state === 'started';
    return {
      items: [
        isRunning
          ? { key: 'stop', label: '停止', icon: <StopOutlined /> }
          : { key: 'start', label: '启动', icon: <PlayCircleOutlined /> },
        { key: 'reload', label: '重启 (reload)', icon: <ReloadOutlined />, disabled: !isRunning },
        { type: 'divider' },
        { key: 'duplicate', label: '克隆配置', icon: <CopyOutlined /> },
        { key: 'export', label: '导出 TOML', icon: <DownloadOutlined /> },
        { type: 'divider' },
        { key: 'delete', label: '删除配置', icon: <DeleteOutlined />, danger: true },
      ],
      onClick: ({ key, domEvent }) => {
        domEvent.stopPropagation();
        switch (key) {
          case 'start': handleStartInstance(item.id); break;
          case 'stop': handleStopInstance(item.id); break;
          case 'reload': handleReloadInstance(item.id); break;
          case 'duplicate': handleDuplicateConfig(item.id); break;
          case 'export': handleExportConfig(item.id); break;
          case 'delete':
            Modal.confirm({
              title: `确定删除「${item.name || item.id}」？`,
              icon: <ExclamationCircleOutlined />,
              content: '删除后该 FRPS 服务端配置无法恢复。',
              okText: '删除',
              okType: 'danger',
              cancelText: '取消',
              onOk: () => handleDeleteConfig(item.id),
            });
            break;
        }
      },
    };
  };

  // 根据当前 Tab 加载对应数据
  const handleLoadConfigDetails = async (id: string) => {
    if (activeTab === 'visual') {
      loadVisualConfig(id);
    } else if (activeTab === 'toml') {
      loadRawToml(id);
    }
    // 'logs' tab：由 <LogConsole> 自行按 instanceId 拉取与实时尾追。
  };

  // 加载常规属性：从 GET /configs/{id} 的 env.config.* / env.frpsmgr.* 回填（不要用列表快照）
  // 全字段表单使用 flattenServerConfig 把 env.config 展平为扁平字段。
  const loadVisualConfig = async (id: string) => {
    try {
      const resp = await client.get(`/api/v1/configs/${id}`);
      if (resp.status === 200) {
        const env = resp.data as ConfigEnvelope;
        setDetailEnvelope(env);
        const cfg = env.config || {};
        const mm = env.frpsmgr || ({} as MgrMeta);
        const flat = flattenServerConfig(cfg as Record<string, unknown>);
        form.resetFields();
        form.setFieldsValue({
          name: mm.name || '',
          manualStart: mm.manualStart ?? false,
          ...flat,
        });
      }
    } catch {
      message.error('获取配置详情失败');
    }
  };

  // 加载 TOML 源码
  const loadRawToml = async (id: string) => {
    setTomlLoading(true);
    try {
      const resp = await client.get(`/api/v1/configs/${id}/raw`);
      if (resp.status === 200) {
        setRawToml(resp.data || '');
      }
    } catch {
      setRawToml('');
    } finally {
      setTomlLoading(false);
    }
  };

  // 保存可视化配置：扁平表单值 → buildServerConfigPayload 折叠为嵌套 ServerConfig
  // 并剪掉空字段/空对象，避免后端 DisallowUnknownFields 误杀。
  //
  // 关键点：
  //   1. webServer 字段不在表单输入范围内（管理器接管），但保留 detailEnvelope.config.webServer
  //      作为占位（mergeServerConfig 不在 MANAGED_TOP_KEYS 里删，会原样透传）。
  //      worker 启动时会强制覆盖 webServer 为 loopback，所以保留旧值无副作用。
  //   2. 透传 ServerConfig 顶层未知字段（如 enablePrometheus、metadatas、httpPlugins）：同上。
  //   3. **清空字段 → 真清空**：mergeServerConfig 先从 baseCfg 删除所有 MANAGED_TOP_KEYS，
  //      再 spread built。用户清空的字段在 built 里没有 key → 最终 payload 也没 →
  //      Go 收到后用零值 → 后端真清空。修复了"清空字段无效"的 bug。
  const handleSaveVisualConfig = async (values: ServerFormValues) => {
    try {
      const built = buildServerConfigPayload(values);
      const cfg = mergeServerConfig(detailEnvelope?.config as Record<string, unknown> | undefined, built) as ServerConfig;

      const frpsmgr: MgrMeta = {
        name: values.name || activeConfigId,
        manualStart: !!values.manualStart,
      };
      await client.put(`/api/v1/configs/${activeConfigId}`, { config: cfg, frpsmgr });
      message.success('配置保存成功！');
      fetchConfigs();
      if (activeConfigId) loadVisualConfig(activeConfigId);
    } catch (err: any) {
      message.error('保存失败: ' + (err.response?.data?.error?.message || err.message || ''));
    }
  };

  // 校验并保存 Raw TOML
  const handleSaveRawToml = async () => {
    setTomlLoading(true);
    try {
      const valResp = await client.post('/api/v1/validate', rawToml, {
        headers: { 'Content-Type': 'application/toml' },
      });
      if (valResp.status === 200 && valResp.data?.valid === false) {
        message.error('TOML 校验未通过: ' + ((valResp.data?.errors || []).join('; ') || '未知错误'));
        return;
      }
      await client.put(`/api/v1/configs/${activeConfigId}/raw`, rawToml, {
        headers: { 'Content-Type': 'application/toml' },
      });
      message.success('TOML 校验并保存成功！');
      fetchConfigs();
      if (activeConfigId) loadRawToml(activeConfigId);
    } catch (err: any) {
      message.error('保存失败: ' + (err.response?.data?.error?.message || 'TOML 语法校验未通过'));
    } finally {
      setTomlLoading(false);
    }
  };

  // 新建配置：只发实际设置的字段（避免 DisallowUnknownFields 400）
  const handleCreateConfig = async (values: NewConfigValues) => {
    try {
      const cfg: ServerConfig = {
        bindAddr: values.bindAddr || undefined,
        bindPort: values.bindPort || 7000,
      };
      if (values.authToken) {
        cfg.auth = { method: 'token', token: values.authToken };
      }
      const frpsmgr: MgrMeta = {
        name: values.name || values.id,
        manualStart: !!values.manualStart,
      };
      await client.post('/api/v1/configs', { id: values.id, config: cfg, frpsmgr });
      message.success('配置创建成功');
      setNewConfigModalOpen(false);
      newConfigForm.resetFields();
      setActiveConfigId(values.id);
      fetchConfigs();
    } catch (err: any) {
      message.error('创建失败: ' + (err.response?.data?.error?.message || err.message));
    }
  };

  const getStatusBadge = (state?: string) => {
    switch (state) {
      case 'started':
        return <Badge status="success" text={<span style={{ color: '#52c41a' }}>正在运行</span>} />;
      case 'starting':
        return <Badge status="processing" text={<span style={{ color: '#1677ff' }}>启动中</span>} />;
      case 'stopping':
        return <Badge status="processing" text={<span style={{ color: '#faad14' }}>停止中</span>} />;
      default:
        return <Badge status="default" text={<span>未启动</span>} />;
    }
  };

  const activeSnap = configs.find(c => c.id === activeConfigId);

  return (
    <div style={{ height: '100%' }}>
      <Row gutter={16} style={{ height: '100%', minHeight: '580px' }}>
        {/* 左栏：实例列表 */}
        <Col xs={24} md={compactList ? 5 : 8} style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 8 }}>
            <Space size={6} style={{ minWidth: 0, flex: 1 }}>
              <Tooltip title={compactList ? '展开列表' : '收起为紧凑列表'}>
                <Button
                  size="small"
                  type="text"
                  icon={compactList ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                  onClick={toggleCompactList}
                />
              </Tooltip>
              {!compactList && <Title level={4} style={{ margin: 0 }}>服务端列表</Title>}
            </Space>
            {compactList ? (
              <Tooltip title="新建配置">
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setNewConfigModalOpen(true)} />
              </Tooltip>
            ) : (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setNewConfigModalOpen(true)}>
                新建配置
              </Button>
            )}
          </div>

          <div style={{ flex: 1, overflowY: 'auto', paddingRight: '4px' }}>
            {configs.length === 0 ? (
              <Card style={{ textAlign: 'center', padding: compactList ? '20px 0' : '40px 0', borderRadius: 10 }}>
                <Empty description={compactList ? '暂无配置' : '暂无 FRPS 服务端配置，点击右上角创建。'} />
              </Card>
            ) : (
              <List
                dataSource={configs}
                renderItem={(item) => {
                  const isActive = item.id === activeConfigId;
                  const isRunning = item.state === 'started';

                  if (compactList) {
                    return (
                      <Dropdown menu={buildContextMenu(item)} trigger={['contextMenu']}>
                        <Tooltip title={`${item.name || item.id} (ID: ${item.id}) · 右键可重启 / 克隆 / 导出 / 删除`} placement="right">
                          <Card
                            hoverable
                            size="small"
                            data-testid={`config-card-${item.id}`}
                            style={{
                              marginBottom: 8,
                              cursor: 'pointer',
                              border: `1px solid ${isActive ? token.colorPrimary : token.colorBorderSecondary}`,
                              background: isActive ? token.colorPrimaryBg : token.colorBgContainer,
                              borderRadius: 8,
                            }}
                            onClick={() => setActiveConfigId(item.id)}
                            styles={{ body: { padding: '8px 10px' } }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <Badge
                                status={
                                  item.state === 'started' ? 'success'
                                  : item.state === 'starting' || item.state === 'stopping' ? 'processing'
                                  : 'default'
                                }
                              />
                              <Text strong ellipsis style={{ fontSize: 13, flex: 1, minWidth: 0 }}>
                                {item.name || item.id}
                              </Text>
                              <Button
                                size="small"
                                type="text"
                                icon={isRunning ? <StopOutlined /> : <PlayCircleOutlined />}
                                loading={statusLoading[item.id]}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  isRunning ? handleStopInstance(item.id) : handleStartInstance(item.id);
                                }}
                                style={{ color: isRunning ? token.colorError : token.colorSuccess }}
                              />
                            </div>
                          </Card>
                        </Tooltip>
                      </Dropdown>
                    );
                  }

                  return (
                    <Dropdown menu={buildContextMenu(item)} trigger={['contextMenu']}>
                      <Card
                        hoverable
                        data-testid={`config-card-${item.id}`}
                        style={{
                          marginBottom: 12,
                          cursor: 'pointer',
                          border: `1px solid ${isActive ? token.colorPrimary : token.colorBorderSecondary}`,
                          background: isActive ? token.colorPrimaryBg : token.colorBgContainer,
                          boxShadow: isActive ? `0 0 0 2px ${token.colorPrimaryBg}` : undefined,
                          borderRadius: 10,
                        }}
                        onClick={() => setActiveConfigId(item.id)}
                        styles={{ body: { padding: 16 } }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '8px' }}>
                          <div>
                            <Text strong style={{ fontSize: '15px' }}>{item.name || item.id}</Text>
                            <div><Text type="secondary" style={{ fontSize: '12px' }}>ID: {item.id}</Text></div>
                          </div>
                          {getStatusBadge(item.state)}
                        </div>

                        <div style={{ borderBottom: `1px solid ${token.colorBorderSecondary}`, margin: '8px 0' }} />

                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <Space>
                            {isRunning ? (
                              <Button
                                type="primary"
                                danger
                                size="small"
                                icon={<StopOutlined />}
                                onClick={(e) => { e.stopPropagation(); handleStopInstance(item.id); }}
                                loading={statusLoading[item.id]}
                              >
                                停止
                              </Button>
                            ) : (
                              <Button
                                type="primary"
                                size="small"
                                icon={<PlayCircleOutlined />}
                                onClick={(e) => { e.stopPropagation(); handleStartInstance(item.id); }}
                                loading={statusLoading[item.id]}
                                style={{ background: '#52c41a', borderColor: '#52c41a' }}
                              >
                                启动
                              </Button>
                            )}
                            {isRunning && (
                              <Tooltip title="重启 (reload)">
                                <Button
                                  size="small"
                                  icon={<ReloadOutlined />}
                                  onClick={(e) => { e.stopPropagation(); handleReloadInstance(item.id); }}
                                  loading={statusLoading[item.id]}
                                />
                              </Tooltip>
                            )}
                          </Space>

                          <Space>
                            <Tooltip title="克隆配置">
                              <Button
                                size="small"
                                type="text"
                                icon={<CopyOutlined />}
                                onClick={(e) => { e.stopPropagation(); handleDuplicateConfig(item.id); }}
                              />
                            </Tooltip>
                            <Popconfirm
                              title="确定要删除这个配置吗？"
                              description="删除后该 FRPS 服务端配置无法恢复。"
                              onConfirm={() => handleDeleteConfig(item.id)}
                              onPopupClick={(e) => e.stopPropagation()}
                              okText="确定"
                              cancelText="取消"
                            >
                              <Button
                                size="small"
                                type="text"
                                danger
                                icon={<DeleteOutlined />}
                                onClick={(e) => e.stopPropagation()}
                              />
                            </Popconfirm>
                          </Space>
                        </div>
                      </Card>
                    </Dropdown>
                  );
                }}
              />
            )}
          </div>
        </Col>

        {/* 右栏：工作台面板 */}
        <Col xs={24} md={compactList ? 19 : 16}>
          {activeConfigId ? (
            <Card
              bordered={false}
              styles={{ body: { padding: 20 } }}
              style={{ height: '100%', minHeight: '520px', display: 'flex', flexDirection: 'column', borderRadius: 10 }}
            >
              <div style={{ marginBottom: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <Text type="secondary" style={{ fontSize: '12px' }}>当前操作实例</Text>
                    <Title level={4} style={{ margin: '4px 0 0 0' }}>
                      {activeSnap?.name || activeConfigId}
                    </Title>
                  </div>
                  <div>{getStatusBadge(activeSnap?.state)}</div>
                </div>
                {/* 实时运行预览：仅运行中且取到数据时显示（组件内部自管轮询与隐藏） */}
                <div style={{ marginTop: activeSnap?.state === 'started' ? 10 : 0 }}>
                  <InstanceLivePreview instanceId={activeConfigId} running={activeSnap?.state === 'started'} />
                </div>
              </div>

              <Tabs
                activeKey={activeTab}
                onChange={setActiveTab}
                items={[
                  {
                    key: 'visual',
                    label: <Space><EditOutlined />常规配置 (可视化)</Space>,
                    children: (
                      <Form
                        form={form}
                        layout="vertical"
                        onFinish={handleSaveVisualConfig}
                        style={{ marginTop: '12px' }}
                      >
                        <ServerConfigGroups
                          envelopeWebServer={(detailEnvelope?.config?.webServer as WebServerInfo | undefined)}
                          themeBorderColor={token.colorBorderSecondary}
                          logPath={detailEnvelope?.log_path}
                        />
                      </Form>
                    ),
                  },
                  {
                    key: 'toml',
                    label: <Space><CodeOutlined />高级 TOML 配置</Space>,
                    children: (
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', gap: 12, flexWrap: 'wrap' }}>
                          <Space size={8}>
                            <Tag color="cyan" bordered={false}>TOML</Tag>
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              CodeMirror 编辑器 · 语法高亮 · Ctrl+F 搜索 · 保存时自动调用 /validate
                            </Text>
                          </Space>
                          <Space>
                            <Tooltip title="刷新读取磁盘上的 TOML">
                              <Button
                                size="small"
                                icon={<ReloadOutlined />}
                                onClick={() => loadRawToml(activeConfigId)}
                                loading={tomlLoading}
                              />
                            </Tooltip>
                            <Button
                              type="primary"
                              icon={<CheckCircleOutlined />}
                              onClick={handleSaveRawToml}
                              loading={tomlLoading}
                              style={{ background: '#52c41a', borderColor: '#52c41a' }}
                            >
                              校验并保存
                            </Button>
                          </Space>
                        </div>
                        <div
                          style={{
                            border: `1px solid ${themeMode === 'dark' ? token.colorBorderSecondary : '#1f2933'}`,
                            borderRadius: 8,
                            overflow: 'hidden',
                            background: '#0b0f14',
                            boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.5)',
                          }}
                        >
                          <CodeMirror
                            value={rawToml}
                            onChange={(v) => setRawToml(v)}
                            theme={oneDark}
                            extensions={tomlExtensions}
                            height="calc(100vh - 320px)"
                            minHeight="420px"
                            maxHeight="78vh"
                            basicSetup={{
                              lineNumbers: true,
                              foldGutter: true,
                              highlightActiveLine: true,
                              highlightActiveLineGutter: true,
                              bracketMatching: true,
                              closeBrackets: true,
                              autocompletion: false,
                              tabSize: 2,
                              searchKeymap: true,
                            }}
                            style={{ fontSize: 13 }}
                          />
                        </div>
                      </div>
                    ),
                  },
                  {
                    key: 'logs',
                    label: <Space><FileTextOutlined />运行日志</Space>,
                    children: activeTab === 'logs' ? (
                      <LogConsole instanceId={activeConfigId} />
                    ) : null,
                  },
                ]}
              />
            </Card>
          ) : (
            <Card style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '100px 0', borderRadius: 10 }}>
              <Empty description="请在左侧选择或创建一个 FRPS 服务端配置。" />
            </Card>
          )}
        </Col>
      </Row>

      {/* 新建配置 Modal */}
      <Modal
        title="新建 FRPS 服务端配置"
        open={newConfigModalOpen}
        onCancel={() => setNewConfigModalOpen(false)}
        maskClosable={false}
        footer={null}
        destroyOnClose
      >
        <Form form={newConfigForm} layout="vertical" onFinish={handleCreateConfig}>
          <Form.Item
            label="唯一ID标识 (必须为纯英文/数字/下划线)"
            name="id"
            rules={[
              { required: true, message: '请输入配置ID' },
              { pattern: /^[a-zA-Z0-9_-]+$/, message: '仅支持英文字母、数字、下划线及中划线' },
            ]}
          >
            <Input placeholder="例如: edge_server" />
          </Form.Item>
          <Form.Item label="显示名称备注" name="name">
            <Input placeholder="例如: 公司边缘节点" />
          </Form.Item>
          <Form.Item label="监听地址 (bindAddr)" name="bindAddr" initialValue="0.0.0.0">
            <Input placeholder="0.0.0.0" />
          </Form.Item>
          <Form.Item label="监听端口 (bindPort)" name="bindPort" initialValue={7000}>
            <InputNumber min={1} max={65535} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="Token 密钥 (auth.token)" name="authToken">
            <Input.Password placeholder="客户端连接此服务端使用的密钥，可空" />
          </Form.Item>
          <Form.Item label="手动启动" name="manualStart" valuePropName="checked" initialValue={false}>
            <Switch checkedChildren="手动启动" unCheckedChildren="随服务启动" />
          </Form.Item>
          <Form.Item style={{ textAlign: 'right', marginBottom: 0 }}>
            <Space>
              <Button onClick={() => setNewConfigModalOpen(false)}>取消</Button>
              <Button type="primary" htmlType="submit">创建</Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default Configs;
