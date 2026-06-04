package config

import (
	frpconfig "github.com/fatedier/frp/pkg/config"
	v1 "github.com/fatedier/frp/pkg/config/v1"
	gotoml "github.com/pelletier/go-toml/v2"
)

// ServerConfigV1 是 frps 服务端配置的 API 层包装。内嵌上游 v1.ServerConfig
// （bindPort/vhost*/auth/transport/webServer/log/sshTunnelGateway/allowPorts 等，
// 全部 camelCase）。管理器元数据（显示名、手动启动）不在此结构里，存 meta.json。
type ServerConfigV1 struct {
	v1.ServerConfig
}

// ParseServerTOML 解析 frp 原生 server TOML 字节为 ServerConfigV1。
// strict=false：容忍未知字段，避免上游新增 key 导致硬失败。
func ParseServerTOML(b []byte) (*ServerConfigV1, error) {
	sc := &ServerConfigV1{}
	if err := frpconfig.LoadConfigure(b, &sc.ServerConfig, false); err != nil {
		return nil, err
	}
	return sc, nil
}

// MarshalTOML 把 ServerConfigV1 序列化为 frp 原生 server TOML。
func (s *ServerConfigV1) MarshalTOML() ([]byte, error) {
	return gotoml.Marshal(&s.ServerConfig)
}

// Complete 填充上游默认值（bindAddr、heartbeatTimeout 等依赖逻辑）。
// 在写盘/校验前调用，保证回读字段稳定。
// 注意 v0.69.1：(*ServerConfig).Complete() 返回 error，须向上传递。
func (s *ServerConfigV1) Complete() error {
	return s.ServerConfig.Complete()
}
