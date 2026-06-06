//go:build windows

package selfupdate

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
)

// Windows process creation flags. CREATE_BREAKAWAY_FROM_JOB is the key one:
// NSSM puts the service in a Job object and kills the whole job on stop, so
// the updater must break away from it (the analogue of systemd-run escaping
// the cgroup on Linux). DETACHED_PROCESS + a new process group keep it alive
// once the daemon exits.
const (
	createNewProcessGroup  = 0x00000200
	detachedProcess        = 0x00000008
	createBreakawayFromJob = 0x01000000
	createNoWindow         = 0x08000000
)

func spawnUpdater(u *Updater, _ Mode, targetVersion string) error {
	psCmd := buildWindowsUpdateCmd(u, targetVersion)

	cmd := exec.Command("powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCmd)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: detachedProcess | createNewProcessGroup | createBreakawayFromJob | createNoWindow,
	}
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

func buildWindowsUpdateCmd(u *Updater, targetVersion string) string {
	args := "-Update -Force"
	if v := strings.TrimSpace(targetVersion); v != "" {
		args += " -Version " + psQuote(v)
	}
	url := psQuote(u.cfg.InstallPs1URL)
	// Start-Sleep lets the HTTP 202 flush; download install.ps1 and run it
	// with -Update so it stops the service (releasing the exe lock), swaps the
	// binary and restarts.
	return fmt.Sprintf(
		`Start-Sleep -Seconds 2; & ([scriptblock]::Create((Invoke-RestMethod -UseBasicParsing %s))) %s`,
		url, args,
	)
}

// psQuote single-quotes a string for safe interpolation into a PowerShell
// command (single quotes are escaped by doubling).
func psQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}
