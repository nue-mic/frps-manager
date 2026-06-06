import { useCallback, useEffect, useState } from 'react';
import {
  Card,
  Space,
  Typography,
  Button,
  Tag,
  Alert,
  Modal,
  App,
  Spin,
  Progress,
  theme as antdTheme,
} from 'antd';
import {
  CloudDownloadOutlined,
  CheckCircleOutlined,
  ReloadOutlined,
  RocketOutlined,
  ArrowRightOutlined,
  ReadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { checkVersion, startUpdate, waitForRestart, type VersionCheckResp } from '../api/update';
import { fmtDateTime } from '../utils/time';

const { Text, Title, Paragraph } = Typography;

type Phase = 'loading' | 'ready' | 'updating' | 'done' | 'failed';

/** 部署模式的中文标签。 */
const MODE_LABEL: Record<string, string> = {
  docker: 'Docker 容器',
  systemd: 'systemd 服务',
  openrc: 'OpenRC 服务',
  launchd: 'launchd 服务',
  'windows-service': 'Windows 服务',
  manual: '手动运行',
};

const UpdateCard: React.FC = () => {
  const { token } = antdTheme.useToken();
  const { message, modal } = App.useApp();

  const [info, setInfo] = useState<VersionCheckResp | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [checking, setChecking] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [progressText, setProgressText] = useState('');
  const [newVersion, setNewVersion] = useState('');

  const runCheck = useCallback(
    async (force: boolean) => {
      setChecking(true);
      try {
        const r = await checkVersion(force);
        setInfo(r);
        setPhase('ready');
        if (force) {
          message.success(r.has_update ? `发现新版本 ${r.latest}` : '已是最新版本');
        }
      } catch {
        message.error('检查更新失败，请稍后重试');
        setPhase('ready');
      } finally {
        setChecking(false);
      }
    },
    [message]
  );

  useEffect(() => {
    void runCheck(false);
  }, [runCheck]);

  const hasUpdate = !!info?.has_update;
  const canSelf = !!info?.can_self_update;

  const doUpdate = useCallback(async () => {
    if (!info) return;
    const fromV = info.current;
    setPhase('updating');
    setProgressText('正在下载新版本并替换二进制…');
    try {
      const r = await startUpdate(false);
      setProgressText(`更新已启动（${r.from} → ${r.to}），服务正在重启，请勿关闭页面…`);
      const v = await waitForRestart(fromV);
      setNewVersion(v);
      setPhase('done');
      message.success(`更新完成，当前版本 ${v}`);
    } catch (e) {
      const err = e as { response?: { data?: { error?: { message?: string } } }; message?: string };
      const detail = err.response?.data?.error?.message || err.message || '更新失败';
      setProgressText(detail);
      setPhase('failed');
      message.error(detail);
    }
  }, [info, message]);

  const confirmUpdate = useCallback(() => {
    if (!info) return;
    modal.confirm({
      title: '确认立即更新并重启？',
      icon: <WarningOutlined style={{ color: token.colorWarning }} />,
      content: (
        <div style={{ fontSize: 13 }}>
          <Paragraph style={{ marginBottom: 8 }}>
            将从 <Text code>{info.current}</Text> 更新到 <Text code>{info.latest}</Text>。
          </Paragraph>
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            更新过程会<Text strong>替换二进制并重启守护进程</Text>，期间管理面板会短暂断开（通常十几秒）。
            端口、令牌、隧道配置与数据<Text strong>不会丢失</Text>。
          </Paragraph>
        </div>
      ),
      okText: '立即更新',
      okButtonProps: { danger: true, icon: <RocketOutlined /> },
      cancelText: '取消',
      onOk: doUpdate,
    });
  }, [info, modal, token.colorWarning, doUpdate]);

  // ---- 更新中 / 完成 / 失败：独占视图 ----
  if (phase === 'updating' || phase === 'done' || phase === 'failed') {
    return (
      <Card style={{ borderRadius: 10 }}>
        <div style={{ textAlign: 'center', padding: '20px 12px' }}>
          {phase === 'updating' && (
            <>
              <Spin size="large" />
              <Title level={5} style={{ marginTop: 20 }}>
                正在更新…
              </Title>
              <Progress percent={100} status="active" showInfo={false} style={{ maxWidth: 360, margin: '12px auto' }} />
            </>
          )}
          {phase === 'done' && (
            <>
              <CheckCircleOutlined style={{ fontSize: 48, color: token.colorSuccess }} />
              <Title level={5} style={{ marginTop: 16 }}>
                更新完成 · 当前版本 {newVersion}
              </Title>
            </>
          )}
          {phase === 'failed' && (
            <>
              <WarningOutlined style={{ fontSize: 48, color: token.colorError }} />
              <Title level={5} style={{ marginTop: 16 }}>
                更新未完成
              </Title>
            </>
          )}
          <Paragraph type="secondary" style={{ marginTop: 8, maxWidth: 520, marginInline: 'auto' }}>
            {progressText}
          </Paragraph>
          {phase === 'done' && (
            <Button type="primary" icon={<ReloadOutlined />} onClick={() => window.location.reload()}>
              刷新页面
            </Button>
          )}
          {phase === 'failed' && (
            <Space>
              <Button icon={<ReloadOutlined />} onClick={() => window.location.reload()}>
                刷新页面
              </Button>
              <Button onClick={() => void runCheck(true)}>重新检查</Button>
            </Space>
          )}
        </div>
      </Card>
    );
  }

  // ---- 常规视图 ----
  const accent = hasUpdate ? token.colorWarning : token.colorSuccess;

  return (
    <>
      <Card
        styles={{ body: { padding: 0 } }}
        style={{
          borderRadius: 10,
          overflow: 'hidden',
          border: `1px solid ${hasUpdate ? token.colorWarningBorder : token.colorBorderSecondary}`,
        }}
      >
        {/* 左侧强调条 */}
        <div style={{ display: 'flex', alignItems: 'stretch' }}>
          <div style={{ width: 4, background: accent, flex: '0 0 auto' }} />
          <div style={{ flex: 1, padding: 18 }}>
            <Space align="center" size={10} style={{ marginBottom: 12 }}>
              <CloudDownloadOutlined style={{ fontSize: 18, color: accent }} />
              <Title level={5} style={{ margin: 0 }}>
                版本升级
              </Title>
              {phase === 'loading' ? (
                <Spin size="small" />
              ) : hasUpdate ? (
                <Tag color="warning">发现新版本</Tag>
              ) : (
                <Tag color="success" icon={<CheckCircleOutlined />}>
                  已是最新
                </Tag>
              )}
            </Space>

            {/* 版本对比 */}
            <Space size={12} align="center" wrap style={{ marginBottom: 12 }}>
              <VersionPill label="当前" value={info?.current} token={token} />
              {hasUpdate && (
                <>
                  <ArrowRightOutlined style={{ color: token.colorTextSecondary }} />
                  <VersionPill label="最新" value={info?.latest} token={token} highlight accent={accent} />
                </>
              )}
              {info?.deployment_mode && (
                <Tag bordered={false} style={{ marginInlineStart: 4 }}>
                  部署：{MODE_LABEL[info.deployment_mode] || info.deployment_mode}
                </Tag>
              )}
            </Space>

            {/* 检查失败提示 */}
            {info?.check_error && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message="无法获取最新版本"
                description={<span style={{ fontSize: 12.5 }}>{info.check_error}（可能是网络受限，可稍后重试）</span>}
              />
            )}

            {/* 不可自更新原因 */}
            {hasUpdate && !canSelf && info?.reason && (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message="此部署方式不支持一键更新"
                description={<span style={{ fontSize: 12.5 }}>{info.reason}</span>}
              />
            )}

            {/* 操作按钮 */}
            <Space wrap size={8}>
              <Button icon={<ReloadOutlined />} loading={checking} onClick={() => void runCheck(true)}>
                检查更新
              </Button>
              {hasUpdate && info?.changelog && (
                <Button icon={<ReadOutlined />} onClick={() => setLogOpen(true)}>
                  查看更新内容
                </Button>
              )}
              {hasUpdate && canSelf && (
                <Button type="primary" danger icon={<RocketOutlined />} onClick={confirmUpdate}>
                  立即更新到 {info?.latest}
                </Button>
              )}
              {info?.html_url && (
                <Button type="link" href={info.html_url} target="_blank" rel="noopener noreferrer">
                  在 GitHub 查看
                </Button>
              )}
            </Space>
          </div>
        </div>
      </Card>

      {/* 更新日志 Modal */}
      <Modal
        title={
          <Space>
            <ReadOutlined />
            更新内容 · {info?.latest}
          </Space>
        }
        open={logOpen}
        onCancel={() => setLogOpen(false)}
        width={680}
        footer={[
          info?.html_url && (
            <Button key="gh" href={info.html_url} target="_blank" rel="noopener noreferrer">
              在 GitHub 查看
            </Button>
          ),
          hasUpdate && canSelf && (
            <Button
              key="up"
              type="primary"
              danger
              icon={<RocketOutlined />}
              onClick={() => {
                setLogOpen(false);
                confirmUpdate();
              }}
            >
              立即更新
            </Button>
          ),
          <Button key="close" onClick={() => setLogOpen(false)}>
            关闭
          </Button>,
        ]}
      >
        <div
          style={{
            maxHeight: '52vh',
            overflowY: 'auto',
            fontSize: 13.5,
            lineHeight: 1.7,
            color: token.colorText,
          }}
        >
          <Markdown>{info?.changelog || '（本版本未提供更新说明）'}</Markdown>
          {info?.published_at && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              发布于 {fmtDateTime(info.published_at)}
            </Text>
          )}
        </div>
      </Modal>
    </>
  );
};

/** 版本药丸标签。 */
const VersionPill: React.FC<{
  label: string;
  value?: string;
  token: ReturnType<typeof antdTheme.useToken>['token'];
  highlight?: boolean;
  accent?: string;
}> = ({ label, value, token, highlight, accent }) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '4px 12px',
      borderRadius: 16,
      background: highlight ? `${accent}1a` : token.colorFillTertiary,
      border: `1px solid ${highlight ? accent : token.colorBorderSecondary}`,
      fontSize: 13,
    }}
  >
    <Text type="secondary" style={{ fontSize: 11.5 }}>
      {label}
    </Text>
    <Text strong style={{ color: highlight ? accent : token.colorText }}>
      {value || '—'}
    </Text>
  </span>
);

/** react-markdown 包一层，约束图片宽度并给代码块基础样式。 */
const Markdown: React.FC<{ children: string }> = ({ children }) => (
  <div className="changelog-markdown">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" />,
        img: (props) => <img {...props} style={{ maxWidth: '100%' }} alt={props.alt || ''} />,
      }}
    >
      {children}
    </ReactMarkdown>
  </div>
);

export default UpdateCard;
