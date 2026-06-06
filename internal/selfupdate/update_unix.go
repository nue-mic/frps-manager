//go:build !windows

package selfupdate

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
)

// spawnUpdater launches the detached updater on Unix-like systems.
//
// On systemd, `systemctl restart` (KillMode=control-group) would terminate a
// plain child process mid-update because it lives in the service's cgroup.
// We therefore launch via `systemd-run`, which runs the command in its own
// transient unit outside our cgroup so the restart can't reach it. OpenRC,
// launchd and bare hosts have no such cgroup semantics, so a `setsid` detach
// is sufficient.
func spawnUpdater(u *Updater, mode Mode, targetVersion string) error {
	shellCmd := buildUnixUpdateCmd(u, targetVersion)

	if mode == ModeSystemd && hasExec("systemd-run") {
		args := []string{"--collect", "--unit", "frpsmgrd-selfupdate", "/bin/sh", "-c", shellCmd}
		out, err := exec.Command("systemd-run", args...).CombinedOutput()
		if err != nil {
			return fmt.Errorf("systemd-run failed: %v: %s", err, strings.TrimSpace(string(out)))
		}
		return nil
	}

	cmd := exec.Command("/bin/sh", "-c", shellCmd)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if f, err := os.OpenFile(u.logPath(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); err == nil {
		cmd.Stdout = f
		cmd.Stderr = f
		defer f.Close()
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("spawn updater failed: %w", err)
	}
	_ = cmd.Process.Release()
	return nil
}

func buildUnixUpdateCmd(u *Updater, targetVersion string) string {
	args := "--update --force"
	if v := strings.TrimSpace(targetVersion); v != "" {
		args += " -v " + shellQuote(v)
	}
	url := shellQuote(u.cfg.InstallShURL)
	log := shellQuote(u.logPath())
	// `sleep 2` lets the HTTP 202 response flush before we tear ourselves
	// down; fetch install.sh via curl (falling back to wget) and pipe it into
	// `sh --update`, which swaps the binary and restarts the service.
	return fmt.Sprintf(
		`sleep 2; { if command -v curl >/dev/null 2>&1; then curl -fsSL %s; else wget -qO- %s; fi; } | sh -s -- %s >> %s 2>&1`,
		url, url, args, log,
	)
}

// shellQuote single-quotes a string for safe interpolation into /bin/sh -c.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
