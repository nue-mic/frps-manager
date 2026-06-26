package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	frpconfig "github.com/fatedier/frp/pkg/config"

	"github.com/nue-mic/frps-manager/services"
)

// runFrpsWorker 是隐藏子命令：在独立进程内跑恰好一个 frps。
// 父进程通过 re-exec 自身 + --config + --webport 启动它。
//
// 为何要子进程：frps 的 mem.StatsCollector 是进程级全局单例，同进程跑多个 frps
// 会把所有实例流量混在一起、无法按实例分离。每个 worker 独立进程 → 独立 collector。
//
// webServer 端口策略（v0.69.1 源码核验，见计划 R1）：frps 仅当 WebServer.Port>0
// 才起 webServer 并调 EnableMem()；Port==0 时根本不起。故端口必须由父进程预分配
// 一个非零空闲 loopback 端口后经 --webport 传入，绝不能用 0。
func runFrpsWorker(args []string) int {
	fs := flag.NewFlagSet("frps-worker", flag.ExitOnError)
	cfgPath := fs.String("config", "", "path to frps server TOML")
	webPort := fs.Int("webport", 0, "loopback webServer port (pre-allocated by parent, must be non-zero)")
	_ = fs.Parse(args)
	if *cfgPath == "" {
		fmt.Fprintln(os.Stderr, "frps-worker: --config required")
		return 2
	}
	if *webPort <= 0 {
		fmt.Fprintln(os.Stderr, "frps-worker: --webport must be a non-zero pre-allocated port")
		return 2
	}

	sc, _, err := frpconfig.LoadServerConfig(*cfgPath, false)
	if err != nil {
		fmt.Fprintf(os.Stderr, "frps-worker: load config: %v\n", err)
		return 1
	}

	// 强制把 webServer 绑到预分配的 loopback 端口 + 随机账密。
	// 这样 frps 自己会调用恰好一次 EnableMem()（我们绝不再调，避免流量翻倍），
	// 父进程也能通过该 loopback 取 mem 指标与 /api/clients。
	user := randToken(6)
	pass := randToken(16)
	sc.WebServer.Addr = "127.0.0.1"
	sc.WebServer.Port = *webPort
	sc.WebServer.User = user
	sc.WebServer.Password = pass
	if err := sc.Complete(); err != nil {
		fmt.Fprintf(os.Stderr, "frps-worker: complete config: %v\n", err)
		return 1
	}

	svc, err := services.NewFrpServerService(sc)
	if err != nil {
		fmt.Fprintf(os.Stderr, "frps-worker: new service: %v\n", err)
		return 1
	}

	// 握手：把 loopback 地址与随机账密作为 stdout 首行回报父进程。
	fmt.Printf("FRPS_WORKER_READY addr=127.0.0.1:%d user=%s pass=%s\n", *webPort, user, pass)
	_ = os.Stdout.Sync()

	// 父进程在 stop 时通过 ctx 取消（Unix: SIGTERM；Windows: 进程 Kill）。
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	svc.Run(ctx) // 阻塞直到 ctx 取消
	_ = svc.Close()
	return 0
}

// randToken 返回 nbytes 字节的随机十六进制串，用于 worker loopback webServer 账密。
func randToken(nbytes int) string {
	b := make([]byte, nbytes)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
