import { useEffect, useRef, useState, useMemo } from 'react';
import { Badge, Input, Tag, Switch, Button, Tooltip, Space, Typography, App } from 'antd';
import {
  DeleteOutlined,
  ReloadOutlined,
  CopyOutlined,
  VerticalAlignBottomOutlined,
} from '@ant-design/icons';
import client, { getAPIToken } from '../api/client';
import { stripLogNoise, logLineClass, logLineLevel, type LogLevel } from '../utils/log';

// 可复用的「多实例实时日志控制台」。给定 instanceId 即自包含：
//   - 拉最近 N 行历史（GET /configs/{id}/logs）
//   - WebSocket 实时尾追新增行（/configs/{id}/logs/tail，token 走 query 兜底）
//   - 关键字过滤 + 级别筛选（D/I/W/E）+ 暂停 + 自动滚底 + 复制 + 清空 + 重连
// Configs 右侧「运行日志」tab 与独立 Logs 页共用本组件，保证样式/逻辑一致。

const MAX_LINES = 1000;

type WsState = 'idle' | 'connecting' | 'connected' | 'closed';

interface LogConsoleProps {
  instanceId: string;
  /** 终端高度，默认按视口自适应。 */
  height?: number | string;
  /** 无实例时的占位提示。 */
  emptyHint?: string;
}

const LEVEL_CHIPS: { key: Exclude<LogLevel, 'other'>; label: string }[] = [
  { key: 'debug', label: '调试' },
  { key: 'info', label: '信息' },
  { key: 'warn', label: '警告' },
  { key: 'error', label: '错误' },
];

const LogConsole: React.FC<LogConsoleProps> = ({ instanceId, height, emptyHint }) => {
  const { message } = App.useApp();

  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [wsState, setWsState] = useState<WsState>('idle');
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState('');
  // 启用显示的级别集合（不在集合内的级别被隐藏；'other' 恒显示）。
  const [levels, setLevels] = useState<Set<LogLevel>>(
    () => new Set<LogLevel>(['debug', 'info', 'warn', 'error', 'other'])
  );

  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const autoScrollRef = useRef(autoScroll);
  autoScrollRef.current = autoScroll;
  const wsRef = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  // 每次连接自增，回调用闭包捕获本次 epoch，避免旧连接的帧写进新实例缓冲。
  const epochRef = useRef(0);

  const disconnect = () => {
    if (wsRef.current) {
      try { wsRef.current.close(); } catch { /* ignore */ }
      wsRef.current = null;
    }
  };

  const load = (id: string) => {
    disconnect();
    const epoch = ++epochRef.current;
    setLines([]);
    if (!id) {
      setWsState('idle');
      return;
    }
    setLoading(true);
    // 历史日志（实例从未启动过时文件不存在，静默忽略）
    client
      .get(`/api/v1/configs/${id}/logs?lines=${MAX_LINES}`)
      .then((resp) => {
        if (epochRef.current !== epoch) return;
        const data = resp.data;
        const hist: string[] = Array.isArray(data?.lines)
          ? data.lines
          : Array.isArray(data)
            ? data
            : [];
        setLines(hist.slice(-MAX_LINES).map(stripLogNoise));
      })
      .catch(() => { /* 文件不存在很正常 */ })
      .finally(() => {
        if (epochRef.current === epoch) setLoading(false);
      });

    // 实时尾追
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const apiToken = getAPIToken();
    const wsUrl = `${protocol}//${window.location.host}/api/v1/configs/${id}/logs/tail?token=${encodeURIComponent(apiToken || '')}`;
    setWsState('connecting');
    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      ws.onopen = () => { if (epochRef.current === epoch) setWsState('connected'); };
      ws.onmessage = (evt) => {
        if (epochRef.current !== epoch || pausedRef.current) return;
        let line: string | null = null;
        try {
          const obj = JSON.parse(evt.data);
          if (obj && typeof obj.line === 'string') line = obj.line;
        } catch {
          if (typeof evt.data === 'string') line = evt.data;
        }
        if (line === null) return;
        const clean = stripLogNoise(line);
        setLines((prev) => {
          const next = prev.length >= MAX_LINES ? prev.slice(prev.length - MAX_LINES + 1) : prev.slice();
          next.push(clean);
          return next;
        });
      };
      ws.onerror = () => { if (epochRef.current === epoch) setWsState('closed'); };
      ws.onclose = () => { if (epochRef.current === epoch) setWsState('closed'); };
    } catch {
      setWsState('closed');
    }
  };

  // 实例变化时重连。
  useEffect(() => {
    load(instanceId);
    return () => disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId]);

  // 新行进来时自动滚到底（暂停或关闭自动滚动时不滚）。
  useEffect(() => {
    if (paused || !autoScroll) return;
    bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [lines, paused, autoScroll]);

  const visible = useMemo(() => {
    const kw = filter.trim().toLowerCase();
    return lines.filter((l) => {
      const lv = logLineLevel(l);
      // 'other'（无法判定级别的行）恒显示，不受级别 chip 影响（也无对应 chip）。
      if (lv !== 'other' && !levels.has(lv)) return false;
      if (kw && !l.toLowerCase().includes(kw)) return false;
      return true;
    });
  }, [lines, filter, levels]);

  const toggleLevel = (lv: LogLevel, on: boolean) => {
    setLevels((prev) => {
      const next = new Set(prev);
      if (on) next.add(lv); else next.delete(lv);
      return next;
    });
  };

  const onCopy = async () => {
    const text = visible.join('\n');
    if (!text) { message.warning('暂无日志可复制'); return; }
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.focus(); ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      message.success(`已复制 ${visible.length} 行日志`);
    } catch {
      message.error('复制失败，请手动选择文本复制');
    }
  };

  const onClear = async () => {
    if (!instanceId) return;
    try {
      // 后端「清空」= 设置展示水位，不删物理文件；之后新行仍会实时推送进来。
      await client.delete(`/api/v1/configs/${instanceId}/logs`);
      setLines([]);
      message.success('日志已清空（仅清视图，物理文件保留）');
    } catch (err: any) {
      message.error('清空失败: ' + (err?.response?.data?.error?.message || err?.message || ''));
    }
  };

  const jumpBottom = () => bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });

  if (!instanceId) {
    return (
      <div style={{ opacity: 0.5, padding: 24, textAlign: 'center' }}>
        {emptyHint || '请先选择一个实例。'}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
        <Space size={10} wrap>
          <Badge
            status={wsState === 'connected' ? 'success' : wsState === 'connecting' ? 'processing' : 'default'}
            text={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {wsState === 'connected' ? '实时流接通' : wsState === 'connecting' ? '正在连接…' : '已断开'}
                {' · '}共 {lines.length} 行
                {visible.length !== lines.length ? ` · 匹配 ${visible.length}` : ''}
              </Typography.Text>
            }
          />
        </Space>
        <Space size={6} wrap>
          <Input
            size="small"
            allowClear
            placeholder="过滤关键字…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ width: 170 }}
          />
          <Space size={2}>
            {LEVEL_CHIPS.map((c) => (
              <Tag.CheckableTag
                key={c.key}
                checked={levels.has(c.key)}
                onChange={(on) => toggleLevel(c.key, on)}
              >
                {c.label}
              </Tag.CheckableTag>
            ))}
          </Space>
          <Tooltip title={paused ? '已暂停接收（点亮恢复实时滚动）' : '实时滚动中（点击暂停）'}>
            <Switch size="small" checked={!paused} onChange={(on) => setPaused(!on)} checkedChildren="实时" unCheckedChildren="暂停" />
          </Tooltip>
          <Tooltip title="自动滚到底部">
            <Switch size="small" checked={autoScroll} onChange={setAutoScroll} checkedChildren="跟随" unCheckedChildren="自由" />
          </Tooltip>
          <Tooltip title="复制当前可见日志">
            <Button size="small" icon={<CopyOutlined />} onClick={onCopy} />
          </Tooltip>
          <Tooltip title="跳到底部">
            <Button size="small" icon={<VerticalAlignBottomOutlined />} onClick={jumpBottom} />
          </Tooltip>
          <Tooltip title="清空视图（保留物理日志文件）">
            <Button size="small" icon={<DeleteOutlined />} onClick={onClear} />
          </Tooltip>
          <Tooltip title="断线重连 / 重新拉取">
            <Button size="small" icon={<ReloadOutlined />} onClick={() => load(instanceId)} />
          </Tooltip>
        </Space>
      </div>

      {loading && lines.length === 0 ? (
        <div style={{ opacity: 0.5, padding: 16, textAlign: 'center' }}>加载中…</div>
      ) : (
        <div
          className="terminal-container"
          style={{
            height: height ?? 'calc(100vh - 320px)',
            minHeight: 360,
            maxHeight: '78vh',
            margin: 0,
            overflowY: 'auto',
            position: 'relative',
          }}
        >
          {visible.length === 0 ? (
            <div style={{ opacity: 0.5, padding: 16, textAlign: 'center' }}>
              {lines.length === 0 ? '暂无日志，等待实例输出…' : '当前过滤/级别条件下无匹配日志'}
            </div>
          ) : (
            <>
              {visible.map((line, idx) => (
                <div key={idx} className={logLineClass(line)}>{line}</div>
              ))}
              <div ref={bottomRef} />
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default LogConsole;
