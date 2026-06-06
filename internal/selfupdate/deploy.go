package selfupdate

import (
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// Mode describes how the daemon is deployed, which decides whether an
// in-place self-update is possible.
type Mode string

const (
	ModeDocker         Mode = "docker"
	ModeSystemd        Mode = "systemd"
	ModeOpenRC         Mode = "openrc"
	ModeLaunchd        Mode = "launchd"
	ModeWindowsService Mode = "windows-service"
	ModeManual         Mode = "manual"
)

// DetectDeployment best-effort identifies the deployment mode. Docker takes
// precedence (a container can't recreate itself), then the platform's init
// system, falling back to "manual" when no service manager is detected.
func DetectDeployment() Mode {
	if isDocker() {
		return ModeDocker
	}
	switch runtime.GOOS {
	case "windows":
		// Best-effort: the installer always registers an NSSM service. If the
		// daemon was started by hand the restart will simply fail and be
		// surfaced via update.log.
		return ModeWindowsService
	case "darwin":
		if fileExists("/Library/LaunchDaemons/com.miaclark.frpsmgrd.plist") {
			return ModeLaunchd
		}
		return ModeManual
	default:
		if dirExists("/run/systemd/system") {
			return ModeSystemd
		}
		if hasExec("rc-service") || hasExec("openrc") {
			return ModeOpenRC
		}
		return ModeManual
	}
}

// CanSelfUpdate reports whether web-triggered self-update is possible for the
// detected deployment, with a human-readable reason when it is not.
func CanSelfUpdate(mode Mode) (bool, string) {
	switch mode {
	case ModeDocker:
		return false, "Docker 部署无法在容器内自我更新，请在宿主机执行：docker compose pull && docker compose up -d"
	case ModeManual:
		return false, "未检测到系统服务（疑似手动运行），无法自动替换二进制并重启；请用安装脚本装成服务后再用一键更新，或改用命令行 fms update"
	default:
		return true, ""
	}
}

func isDocker() bool {
	if fileExists("/.dockerenv") {
		return true
	}
	if b, err := os.ReadFile("/proc/1/cgroup"); err == nil {
		s := string(b)
		if strings.Contains(s, "docker") || strings.Contains(s, "containerd") {
			return true
		}
	}
	return false
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

func dirExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

func hasExec(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func tempDir() string { return os.TempDir() }
