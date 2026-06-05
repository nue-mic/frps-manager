package config

import (
	"encoding/json"

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
//
// 关键细节：上游 v1.ServerConfig 各字段只带 json tag（camelCase 如 bindPort/
// vhostHTTPPort），不带 toml tag。go-toml/v2 在没有 toml tag 时会 fallback 到
// **Go 字段名**（PascalCase 如 BindPort/VhostHTTPPort），那不是 frps 能识别
// 的原生 TOML 格式——导出的文件直接喂给原生 frps 无法解析。
//
// 因此这里走 JSON 桥：先 json.Marshal → map[string]any → toml.Marshal map。
// 这样产出的 TOML key 就是 json tag 名，与原生 frps TOML 完全一致。
// 额外处理：json.Unmarshal 把所有数字解为 float64，会让 `bindPort = 7000`
// 写成 `7000.0`——视觉上不像原生 frps TOML。intifyFloats 把数学上是整数的
// float64 转回 int64。
func (s *ServerConfigV1) MarshalTOML() ([]byte, error) {
	jb, err := json.Marshal(&s.ServerConfig)
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(jb, &m); err != nil {
		return nil, err
	}
	intifyFloats(m)
	return gotoml.Marshal(m)
}

// intifyFloats 把 map / slice 里所有「数学上是整数的 float64」就地转换为 int64。
// 递归处理嵌套 map/slice。修正 json→map→toml 桥引入的 7000.0 风格输出。
func intifyFloats(v any) any {
	switch x := v.(type) {
	case map[string]any:
		for k, vv := range x {
			x[k] = intifyFloats(vv)
		}
		return x
	case []any:
		for i, vv := range x {
			x[i] = intifyFloats(vv)
		}
		return x
	case float64:
		if x == float64(int64(x)) {
			return int64(x)
		}
		return x
	default:
		return v
	}
}

// Complete 填充上游默认值（bindAddr、heartbeatTimeout 等依赖逻辑）。
// 在写盘/校验前调用，保证回读字段稳定。
// 注意 v0.69.1：(*ServerConfig).Complete() 返回 error，须向上传递。
func (s *ServerConfigV1) Complete() error {
	return s.ServerConfig.Complete()
}
