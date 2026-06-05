import { useEffect, useState, useRef } from 'react';
import {
  Card, Row, Col, Button, Badge, Space, Typography, Popconfirm,
  Tabs, Form, Input, InputNumber, Switch, Modal,
  message, Tag, Tooltip, Empty, List, Select, Dropdown,
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
} from '@ant-design/icons';

const LIST_COMPACT_KEY = 'frpmgr_configs_compact';
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

import client, { getAPIToken } from '../api/client';
import { useTheme } from '../theme/ThemeContext';
import { useEventSubscription } from '../events/EventStreamContext';
import type { InstanceStateData } from '../events/types';
import type { Snapshot, ServerConfig, MgrMeta, ConfigEnvelope } from '../api/types';

const { Title, Text } = Typography;

// 可视化表单的字段集合（与 ServerConfig / MgrMeta 字段一一对应，camelCase）。
interface ServerFormValues {
  name?: string;
  manualStart?: boolean;
  bindAddr?: string;
  bindPort?: number;
  vhostHTTPPort?: number;
  vhostHTTPSPort?: number;
  subDomainHost?: string;
  authMethod?: 'token' | 'oidc';
  authToken?: string;
  logLevel?: string;
  logMaxDays?: number;
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

  // 迷你日志状态
  const MINI_LOGS_MAX = 1000;
  const [miniLogLines, setMiniLogLines] = useState<string[]>([]);
  const [miniLogsLoading, setMiniLogsLoading] = useState<boolean>(false);
  const [miniLogsPaused, setMiniLogsPaused] = useState<boolean>(false);
  const [miniLogsWsState, setMiniLogsWsState] = useState<'idle' | 'connecting' | 'connected' | 'closed'>('idle');
  const miniLogsPausedRef = useRef(miniLogsPaused);
  miniLogsPausedRef.current = miniLogsPaused;
  const miniLogsWsRef = useRef<WebSocket | null>(null);
  const miniLogsBottomRef = useRef<HTMLDivElement | null>(null);

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
              content: '删除后该 frps 服务端配置无法恢复。',
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
    } else if (activeTab === 'logs') {
      loadMiniLogs(id);
    }
  };

  // 加载常规属性：从 GET /configs/{id} 的 env.config.* / env.frpmgr.* 回填（不要用列表快照）
  const loadVisualConfig = async (id: string) => {
    try {
      const resp = await client.get(`/api/v1/configs/${id}`);
      if (resp.status === 200) {
        const env = resp.data as ConfigEnvelope;
        setDetailEnvelope(env);
        const cfg = env.config || {};
        const mm = env.frpmgr || ({} as MgrMeta);
        form.setFieldsValue({
          name: mm.name || '',
          manualStart: mm.manualStart ?? false,
          bindAddr: cfg.bindAddr || '',
          bindPort: cfg.bindPort,
          vhostHTTPPort: cfg.vhostHTTPPort,
          vhostHTTPSPort: cfg.vhostHTTPSPort,
          subDomainHost: cfg.subDomainHost || '',
          authMethod: cfg.auth?.method || 'token',
          authToken: cfg.auth?.token || '',
          logLevel: cfg.log?.level || 'info',
          logMaxDays: cfg.log?.maxDays,
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

  // 关闭实时日志 WebSocket
  const disconnectMiniLogsWS = () => {
    if (miniLogsWsRef.current) {
      try { miniLogsWsRef.current.close(); } catch {/* ignore */}
      miniLogsWsRef.current = null;
    }
    setMiniLogsWsState('closed');
  };

  // 拉取历史日志 + WebSocket 实时尾追
  const loadMiniLogs = async (id: string) => {
    disconnectMiniLogsWS();
    setMiniLogsLoading(true);
    setMiniLogLines([]);
    try {
      const resp = await client.get(`/api/v1/configs/${id}/logs?lines=${MINI_LOGS_MAX}`);
      if (resp.status === 200) {
        const data = resp.data;
        const lines: string[] = Array.isArray(data?.lines) ? data.lines : (Array.isArray(data) ? data : []);
        setMiniLogLines(lines.slice(-MINI_LOGS_MAX));
      }
    } catch {
      // 日志文件不存在很正常（实例从未启动过）
    } finally {
      setMiniLogsLoading(false);
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const apiToken = getAPIToken();
    const wsUrl = `${protocol}//${window.location.host}/api/v1/configs/${id}/logs/tail?token=${encodeURIComponent(apiToken || '')}`;
    setMiniLogsWsState('connecting');
    try {
      const ws = new WebSocket(wsUrl);
      miniLogsWsRef.current = ws;
      ws.onopen = () => setMiniLogsWsState('connected');
      ws.onmessage = (evt) => {
        if (miniLogsPausedRef.current) return;
        let line: string | null = null;
        try {
          const obj = JSON.parse(evt.data);
          if (obj && typeof obj.line === 'string') line = obj.line;
        } catch {
          if (typeof evt.data === 'string') line = evt.data;
        }
        if (line === null) return;
        setMiniLogLines((prev) => {
          const next = prev.length >= MINI_LOGS_MAX ? prev.slice(prev.length - MINI_LOGS_MAX + 1) : prev.slice();
          next.push(line!);
          return next;
        });
      };
      ws.onerror = () => setMiniLogsWsState('closed');
      ws.onclose = () => setMiniLogsWsState('closed');
    } catch {
      setMiniLogsWsState('closed');
    }
  };

  const handleClearMiniLogs = async (id: string) => {
    if (!id) return;
    try {
      await client.delete(`/api/v1/configs/${id}/logs`);
      setMiniLogLines([]);
      message.success('日志已清空');
    } catch (err: any) {
      message.error('清空失败: ' + (err.response?.data?.error?.message || err.message));
    }
  };

  useEffect(() => {
    if (activeTab !== 'logs') {
      disconnectMiniLogsWS();
    }
    return () => disconnectMiniLogsWS();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, activeConfigId]);

  useEffect(() => {
    if (miniLogsPaused) return;
    miniLogsBottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [miniLogLines, miniLogsPaused]);

  const miniLogClass = (line: string): string => {
    if (line.includes('[W]') || /\bwarn(ing)?\b/i.test(line)) return 'log-line log-warn';
    if (line.includes('[E]') || /\berror\b|\bfailed\b/i.test(line)) return 'log-line log-error';
    if (line.includes('[D]') || /\bdebug\b/i.test(line)) return 'log-line log-debug';
    if (line.includes('[I]') || /\binfo\b/i.test(line)) return 'log-line log-info';
    return 'log-line';
  };

  // 保存可视化配置：只发实际要设的字段 + 透传已有 config 的未知字段
  const handleSaveVisualConfig = async (values: ServerFormValues) => {
    try {
      // 以现有 config 为基础（保留 Complete() 补全的全量字段），只覆盖表单管理的字段。
      const baseCfg: ServerConfig = { ...(detailEnvelope?.config ?? {}) };
      const cfg: ServerConfig = {
        ...baseCfg,
        bindAddr: values.bindAddr || undefined,
        bindPort: values.bindPort,
        vhostHTTPPort: values.vhostHTTPPort,
        vhostHTTPSPort: values.vhostHTTPSPort,
        subDomainHost: values.subDomainHost || undefined,
        auth: {
          ...(baseCfg.auth ?? {}),
          method: values.authMethod,
          token: values.authMethod === 'token' ? (values.authToken || '') : undefined,
        },
        log: {
          ...(baseCfg.log ?? {}),
          level: values.logLevel,
          maxDays: values.logMaxDays,
        },
      };
      const frpmgr: MgrMeta = {
        name: values.name || activeConfigId,
        manualStart: !!values.manualStart,
      };
      await client.put(`/api/v1/configs/${activeConfigId}`, { config: cfg, frpmgr });
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
      const frpmgr: MgrMeta = {
        name: values.name || values.id,
        manualStart: !!values.manualStart,
      };
      await client.post('/api/v1/configs', { id: values.id, config: cfg, frpmgr });
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
                <Empty description={compactList ? '暂无配置' : '暂无 frps 服务端配置，点击右上角创建。'} />
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
                              description="删除后该 frps 服务端配置无法恢复。"
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
              <div style={{ marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <Text type="secondary" style={{ fontSize: '12px' }}>当前操作实例</Text>
                  <Title level={4} style={{ margin: '4px 0 0 0' }}>
                    {activeSnap?.name || activeConfigId}
                  </Title>
                </div>
                <div>{getStatusBadge(activeSnap?.state)}</div>
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
                        style={{ maxWidth: '800px', marginTop: '12px' }}
                      >
                        <Row gutter={16}>
                          <Col span={12}>
                            <Form.Item label="实例备注名" name="name">
                              <Input placeholder="例如: 杭州云服务器" />
                            </Form.Item>
                          </Col>
                          <Col span={12}>
                            <Form.Item
                              label="随系统服务自动启动"
                              name="manualStart"
                              valuePropName="checked"
                              tooltip="开启「手动启动」后，守护进程重启不会自动拉起该实例。"
                            >
                              <Switch checkedChildren="手动启动" unCheckedChildren="随服务启动" />
                            </Form.Item>
                          </Col>
                        </Row>

                        <Row gutter={16}>
                          <Col span={16}>
                            <Form.Item label="监听地址 (bindAddr)" name="bindAddr">
                              <Input placeholder="0.0.0.0" />
                            </Form.Item>
                          </Col>
                          <Col span={8}>
                            <Form.Item label="监听端口 (bindPort)" name="bindPort">
                              <InputNumber min={1} max={65535} style={{ width: '100%' }} placeholder="7000" />
                            </Form.Item>
                          </Col>
                        </Row>

                        <Row gutter={16}>
                          <Col span={12}>
                            <Form.Item label="HTTP 虚拟主机端口 (vhostHTTPPort)" name="vhostHTTPPort">
                              <InputNumber min={1} max={65535} style={{ width: '100%' }} placeholder="80" />
                            </Form.Item>
                          </Col>
                          <Col span={12}>
                            <Form.Item label="HTTPS 虚拟主机端口 (vhostHTTPSPort)" name="vhostHTTPSPort">
                              <InputNumber min={1} max={65535} style={{ width: '100%' }} placeholder="443" />
                            </Form.Item>
                          </Col>
                        </Row>

                        <Form.Item label="子域名根 (subDomainHost)" name="subDomainHost">
                          <Input placeholder="例如: frp.example.com" />
                        </Form.Item>

                        <Row gutter={16}>
                          <Col span={8}>
                            <Form.Item label="认证方式 (auth.method)" name="authMethod">
                              <Select
                                options={[
                                  { value: 'token', label: 'Token 认证' },
                                  { value: 'oidc', label: 'OIDC 认证' },
                                ]}
                              />
                            </Form.Item>
                          </Col>
                          <Col span={16}>
                            <Form.Item
                              noStyle
                              shouldUpdate={(p, c) => p.authMethod !== c.authMethod}
                            >
                              {({ getFieldValue }) =>
                                getFieldValue('authMethod') === 'token' ? (
                                  <Form.Item label="Token 密钥 (auth.token)" name="authToken">
                                    <Input.Password placeholder="客户端连接此服务端使用的密钥" />
                                  </Form.Item>
                                ) : (
                                  <Form.Item label="提示" >
                                    <Text type="secondary" style={{ fontSize: 12 }}>
                                      OIDC 详细参数请在「高级 TOML 配置」里设置。
                                    </Text>
                                  </Form.Item>
                                )
                              }
                            </Form.Item>
                          </Col>
                        </Row>

                        <Row gutter={16}>
                          <Col span={12}>
                            <Form.Item label="日志级别 (log.level)" name="logLevel">
                              <Select
                                options={[
                                  { value: 'trace', label: 'trace (最详细)' },
                                  { value: 'debug', label: 'debug (调试)' },
                                  { value: 'info', label: 'info (常规信息)' },
                                  { value: 'warn', label: 'warn (警告)' },
                                  { value: 'error', label: 'error (错误)' },
                                ]}
                              />
                            </Form.Item>
                          </Col>
                          <Col span={12}>
                            <Form.Item label="日志保留天数 (log.maxDays)" name="logMaxDays">
                              <InputNumber min={1} max={90} style={{ width: '100%' }} placeholder="3" />
                            </Form.Item>
                          </Col>
                        </Row>

                        <Form.Item style={{ marginTop: 20, borderTop: `1px solid ${token.colorBorderSecondary}`, paddingTop: 16, textAlign: 'right' }}>
                          <Button type="primary" htmlType="submit">保存服务端配置</Button>
                        </Form.Item>
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
                    label: <Space><EditOutlined />运行日志速览</Space>,
                    children: (
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px', gap: 12, flexWrap: 'wrap' }}>
                          <Space size={10}>
                            <Badge
                              status={
                                miniLogsWsState === 'connected' ? 'success'
                                : miniLogsWsState === 'connecting' ? 'processing'
                                : 'default'
                              }
                              text={
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  {miniLogsWsState === 'connected' ? '实时流接通'
                                    : miniLogsWsState === 'connecting' ? '正在连接…'
                                    : '已断开'} · 最近 {MINI_LOGS_MAX} 行
                                </Text>
                              }
                            />
                          </Space>
                          <Space>
                            <Switch
                              size="small"
                              checked={miniLogsPaused}
                              onChange={setMiniLogsPaused}
                              checkedChildren="已暂停"
                              unCheckedChildren="实时滚动"
                            />
                            <Button size="small" icon={<DeleteOutlined />} onClick={() => handleClearMiniLogs(activeConfigId)}>
                              清空
                            </Button>
                            <Button size="small" icon={<ReloadOutlined />} onClick={() => loadMiniLogs(activeConfigId)}>
                              重连
                            </Button>
                          </Space>
                        </div>
                        {miniLogsLoading && miniLogLines.length === 0 ? (
                          <div style={{ opacity: 0.5, padding: 16, textAlign: 'center' }}>加载中…</div>
                        ) : (
                          <div
                            className="terminal-container"
                            style={{
                              height: 'calc(100vh - 320px)',
                              minHeight: 420,
                              maxHeight: '78vh',
                              margin: 0,
                              overflowY: 'auto',
                              position: 'relative',
                            }}
                          >
                            {miniLogLines.length === 0 ? (
                              <div style={{ opacity: 0.5, padding: 16, textAlign: 'center' }}>
                                暂无日志，等待 frps 输出…
                              </div>
                            ) : (
                              <>
                                {miniLogLines.map((line, idx) => (
                                  <div key={idx} className={miniLogClass(line)}>{line}</div>
                                ))}
                                <div ref={miniLogsBottomRef} />
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    ),
                  },
                ]}
              />
            </Card>
          ) : (
            <Card style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '100px 0', borderRadius: 10 }}>
              <Empty description="请在左侧选择或创建一个 frps 服务端配置。" />
            </Card>
          )}
        </Col>
      </Row>

      {/* 新建配置 Modal */}
      <Modal
        title="新建 frps 服务端配置"
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
