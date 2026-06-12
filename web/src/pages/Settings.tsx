import { useState, useEffect } from 'react';
import {
  Card,
  Space,
  Typography,
  Form,
  Button,
  Switch,
  Divider,
  Descriptions,
  Tag,
  App,
  Row,
  Col,
  Alert,
  Input,
  theme as antdTheme,
} from 'antd';
import {
  UserOutlined,
  SettingOutlined,
  KeyOutlined,
  TagsOutlined,
} from '@ant-design/icons';
import { clearAPIToken, getAPIToken } from '../api/client';
import { useTheme } from '../theme/ThemeContext';
import { useBranding } from '../branding/BrandingContext';
import { updateBranding } from '../api/branding';

const { Title, Text } = Typography;

const Settings: React.FC = () => {
  const { token } = antdTheme.useToken();
  const { message, modal } = App.useApp();
  const { mode, setMode, resolved } = useTheme();
  const { branding, setBrandingLocal } = useBranding();

  const [brandForm] = Form.useForm();
  const [savingBrand, setSavingBrand] = useState(false);
  // 品牌可能在挂载后由公开 GET 异步校正，故用 effect 同步表单回填。
  useEffect(() => {
    brandForm.setFieldsValue({
      app_name: branding.app_name,
      app_subtitle: branding.app_subtitle,
      html_title: branding.html_title,
    });
  }, [branding, brandForm]);

  const onSaveBranding = async (vals: {
    app_name?: string;
    app_subtitle?: string;
    html_title?: string;
  }) => {
    setSavingBrand(true);
    try {
      // 空串显式发给后端 → 重置为默认；后端返回生效值。
      const next = await updateBranding({
        app_name: vals.app_name ?? '',
        app_subtitle: vals.app_subtitle ?? '',
        html_title: vals.html_title ?? '',
      });
      setBrandingLocal(next); // 即时刷新侧边栏 / 登录页 / 浏览器标题
      brandForm.setFieldsValue(next);
      message.success('品牌已保存，已即时生效');
    } catch {
      message.error('保存失败，请检查登录令牌与网络');
    } finally {
      setSavingBrand(false);
    }
  };

  const [autoCollapse, setAutoCollapse] = useState<boolean>(
    () => localStorage.getItem('frpsmgr_sidebar_collapse') === '1'
  );
  const tokenMasked = (() => {
    const t = getAPIToken();
    if (!t) return '未保存';
    if (t.length <= 8) return '****';
    return `${t.slice(0, 4)}…${t.slice(-4)}`;
  })();

  const onChangeToken = () => {
    modal.confirm({
      title: '更换 API Token？',
      content: '这会清除当前保存的 Token 并跳转回登录页，请确保新的 Token 已准备好。',
      okText: '我已准备好',
      cancelText: '取消',
      onOk: () => {
        clearAPIToken();
        message.success('已清除本地 Token');
        window.location.href = '/login';
      },
    });
  };

  const onToggleSidebar = (v: boolean) => {
    setAutoCollapse(v);
    localStorage.setItem('frpsmgr_sidebar_collapse', v ? '1' : '0');
    message.success('已保存，下次刷新生效');
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card styles={{ body: { padding: 18 } }} style={{ borderRadius: 10 }}>
        <Space direction="vertical" size={4}>
          <Title level={4} style={{ margin: 0 }}>
            <SettingOutlined /> 设置
          </Title>
          <Text type="secondary" style={{ fontSize: 13 }}>
            个性化、账户和版本信息。外观与账户偏好保存在浏览器本地；品牌保存在服务端，跨设备 / 清缓存后依然生效。
          </Text>
        </Space>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title={<Space><UserOutlined /> 账户</Space>} styles={{ body: { padding: 18 } }} style={{ borderRadius: 10 }}>
            <Descriptions column={1} size="small" labelStyle={{ width: 100 }}>
              <Descriptions.Item label="鉴权方式">
                <Tag color="processing" icon={<KeyOutlined />}>Bearer Token</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="当前 Token">
                <Text code>{tokenMasked}</Text>
              </Descriptions.Item>
            </Descriptions>
            <Divider style={{ margin: '16px 0' }} />
            <Space>
              <Button danger onClick={onChangeToken}>更换 / 清除 Token</Button>
            </Space>
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 16, borderRadius: 8 }}
              message="安全提示"
              description={
                <Text style={{ fontSize: 12 }}>
                  Token 被存放在浏览器 localStorage 中，存在被 XSS 读取的风险。生产环境建议结合反向代理 IP 白名单 / Basic Auth 一并加固。
                </Text>
              }
            />
          </Card>
        </Col>

        <Col xs={24} lg={12}>
          <Card title={<Space><SettingOutlined /> 外观与交互</Space>} styles={{ body: { padding: 18 } }} style={{ borderRadius: 10 }}>
            <Form layout="horizontal" labelCol={{ span: 8 }} wrapperCol={{ span: 16 }}>
              <Form.Item label="主题模式">
                <Space>
                  <Switch
                    checkedChildren="跟随系统"
                    unCheckedChildren="手动"
                    checked={mode === 'system'}
                    onChange={(v) => setMode(v ? 'system' : resolved)}
                  />
                  {mode !== 'system' && (
                    <Switch
                      checkedChildren="深色"
                      unCheckedChildren="浅色"
                      checked={mode === 'dark'}
                      onChange={(v) => setMode(v ? 'dark' : 'light')}
                    />
                  )}
                  <Tag bordered={false}>当前：{resolved === 'dark' ? '深色' : '浅色'}</Tag>
                </Space>
              </Form.Item>
              <Form.Item label="侧边栏默认折叠">
                <Switch checked={autoCollapse} onChange={onToggleSidebar} />
              </Form.Item>
              <Form.Item label="主色">
                <Text code style={{ background: token.colorPrimary, color: '#fff', padding: '2px 8px' }}>
                  {token.colorPrimary}
                </Text>
              </Form.Item>
            </Form>
          </Card>
        </Col>

      </Row>

      <Card
        title={<Space><TagsOutlined /> 品牌 / 标识</Space>}
        styles={{ body: { padding: 18 } }}
        style={{ borderRadius: 10 }}
      >
        <Form
          form={brandForm}
          layout="vertical"
          onFinish={onSaveBranding}
          style={{ maxWidth: 560 }}
        >
          <Form.Item
            label="品牌名"
            name="app_name"
            extra="显示在侧边栏与登录页顶部。留空恢复默认「FRPS Manager」。"
          >
            <Input placeholder="FRPS Manager" maxLength={40} allowClear />
          </Form.Item>
          <Form.Item
            label="副标题"
            name="app_subtitle"
            extra="品牌名下方的小字（侧边栏）。留空恢复默认「服务端管理面板」。"
          >
            <Input placeholder="服务端管理面板" maxLength={60} allowClear />
          </Form.Item>
          <Form.Item
            label="浏览器标签标题"
            name="html_title"
            extra="浏览器标签页 title。留空恢复默认。"
          >
            <Input placeholder="FRPS Manager · 服务端管理面板" maxLength={120} allowClear />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Button type="primary" htmlType="submit" loading={savingBrand}>
              保存品牌
            </Button>
          </Form.Item>
        </Form>
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 16, borderRadius: 8 }}
          message="保存在服务端"
          description={
            <Text style={{ fontSize: 12 }}>
              品牌保存在守护进程数据目录（meta.json），清浏览器缓存、换浏览器或重新登录后依然生效；首屏由服务端注入，零闪烁。
            </Text>
          }
        />
      </Card>
    </Space>
  );
};

export default Settings;

