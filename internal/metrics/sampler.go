package metrics

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/nue-mic/frps-manager/internal/eventbus"
)

// InstanceSource is the subset of the Manager the sampler needs: which
// instances are running, and how to reach each worker's loopback frps API.
type InstanceSource interface {
	RunningIDs() []string
	Loopback(id string) (addr, user, pass string, ok bool)
}

// Sampler periodically polls each running frps worker's loopback for traffic
// and connection metrics, writes interval deltas to the time-series store, and
// evaluates alert rules. Run blocks until ctx is cancelled.
type Sampler struct {
	store    *Store
	src      InstanceSource
	bus      *eventbus.Bus
	log      *slog.Logger
	interval time.Duration
	client   *http.Client

	// prev cumulative (today) traffic per inst|scope|key for delta computation
	prev map[string]trafficCum
	// alert state per rule id
	alerts map[string]*alertState
	// retention window; points older than this are pruned
	retain time.Duration
}

type trafficCum struct{ in, out int64 }

type alertState struct {
	firingSince int64 // unix sec when condition first held; 0 if not holding
	fired       bool  // whether a firing event is currently open
}

// NewSampler builds a sampler. interval<=0 defaults to 10s; retain<=0 to 7d.
func NewSampler(store *Store, src InstanceSource, bus *eventbus.Bus, log *slog.Logger, interval, retain time.Duration) *Sampler {
	if interval <= 0 {
		interval = 10 * time.Second
	}
	if retain <= 0 {
		retain = 7 * 24 * time.Hour
	}
	if log == nil {
		log = slog.Default()
	}
	return &Sampler{
		store:    store,
		src:      src,
		bus:      bus,
		log:      log,
		interval: interval,
		client:   &http.Client{Timeout: 4 * time.Second},
		prev:     map[string]trafficCum{},
		alerts:   map[string]*alertState{},
		retain:   retain,
	}
}

// Run blocks, sampling every interval until ctx is cancelled.
func (s *Sampler) Run(ctx context.Context) {
	t := time.NewTicker(s.interval)
	defer t.Stop()
	prune := time.NewTicker(time.Hour)
	defer prune.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.tick()
		case <-prune.C:
			cutoff := time.Now().Add(-s.retain).Unix()
			if n, err := s.store.PruneBefore(cutoff); err == nil && n > 0 {
				s.log.Debug("pruned old traffic points", slog.Int64("rows", n))
			}
		}
	}
}

// tick performs one sampling + alert-evaluation pass across running instances.
func (s *Sampler) tick() {
	now := time.Now().Unix()
	stepSec := int64(s.interval / time.Second)
	if stepSec <= 0 {
		stepSec = 1
	}
	points := make([]TrafficPoint, 0, 16)
	rules, _ := s.store.ListRules()

	for _, id := range s.src.RunningIDs() {
		addr, user, pass, ok := s.src.Loopback(id)
		if !ok {
			continue
		}
		srv, perProxy, err := s.fetch(addr, user, pass)
		if err != nil {
			s.log.Debug("sample fetch failed", slog.String("id", id), slog.Any("err", err))
			continue
		}

		// server scope
		sp := s.delta(id, "server", "", srv.in, srv.out, srv.conns, now)
		points = append(points, sp)
		s.evalRules(rules, id, "", srv.conns, sp, stepSec, now)

		// proxy scope
		for name, pm := range perProxy {
			pp := s.delta(id, "proxy", name, pm.in, pm.out, pm.conns, now)
			points = append(points, pp)
			s.evalRules(rules, id, name, pm.conns, pp, stepSec, now)
		}
	}

	if err := s.store.InsertTraffic(points); err != nil {
		s.log.Warn("insert traffic failed", slog.Any("err", err))
	}
}

// delta converts a cumulative (today) reading into an interval-delta point,
// handling the midnight reset (cur<prev → treat delta as 0 to avoid negatives).
func (s *Sampler) delta(id, scope, key string, curIn, curOut, conns, now int64) TrafficPoint {
	k := id + "|" + scope + "|" + key
	prev, seen := s.prev[k]
	var dIn, dOut int64
	if seen {
		if curIn >= prev.in {
			dIn = curIn - prev.in
		}
		if curOut >= prev.out {
			dOut = curOut - prev.out
		}
	}
	s.prev[k] = trafficCum{in: curIn, out: curOut}
	return TrafficPoint{Ts: now, InstID: id, Scope: scope, Key: key, In: dIn, Out: dOut, Conns: conns}
}

type serverSample struct{ in, out, conns int64 }
type proxySample struct{ in, out, conns int64 }

// fetch reads /api/serverinfo and /api/proxy/{type} from one worker loopback.
func (s *Sampler) fetch(addr, user, pass string) (serverSample, map[string]proxySample, error) {
	var srv serverSample
	body, err := s.get(addr, user, pass, "/api/serverinfo")
	if err != nil {
		return srv, nil, err
	}
	var si struct {
		TotalTrafficIn  int64 `json:"totalTrafficIn"`
		TotalTrafficOut int64 `json:"totalTrafficOut"`
		CurConns        int64 `json:"curConns"`
	}
	if err := json.Unmarshal(body, &si); err != nil {
		return srv, nil, err
	}
	srv = serverSample{in: si.TotalTrafficIn, out: si.TotalTrafficOut, conns: si.CurConns}

	perProxy := map[string]proxySample{}
	for _, typ := range []string{"tcp", "udp", "http", "https", "stcp", "sudp", "xtcp", "tcpmux"} {
		pb, err := s.get(addr, user, pass, "/api/proxy/"+typ)
		if err != nil {
			continue
		}
		var pr struct {
			Proxies []struct {
				Name            string `json:"name"`
				TodayTrafficIn  int64  `json:"todayTrafficIn"`
				TodayTrafficOut int64  `json:"todayTrafficOut"`
				CurConns        int64  `json:"curConns"`
			} `json:"proxies"`
		}
		if err := json.Unmarshal(pb, &pr); err != nil {
			continue
		}
		for _, p := range pr.Proxies {
			perProxy[p.Name] = proxySample{in: p.TodayTrafficIn, out: p.TodayTrafficOut, conns: p.CurConns}
		}
	}
	return srv, perProxy, nil
}

func (s *Sampler) get(addr, user, pass, path string) ([]byte, error) {
	req, err := http.NewRequest(http.MethodGet, "http://"+addr+path, nil)
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(user, pass)
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("loopback %s status %d", path, resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 8<<20))
}

// evalRules evaluates all rules that apply to (instID, target) for one sample.
func (s *Sampler) evalRules(rules []AlertRule, instID, target string, conns int64, pt TrafficPoint, stepSec, now int64) {
	for _, r := range rules {
		if !r.Enabled {
			continue
		}
		if r.InstID != "*" && r.InstID != instID {
			continue
		}
		ruleTarget := r.Target
		if ruleTarget == "*" {
			ruleTarget = ""
		}
		// server-scope rule (target empty) matches server samples only;
		// proxy-scope rule matches the named proxy sample only.
		if ruleTarget != target {
			continue
		}
		var value float64
		switch r.Metric {
		case "conns":
			value = float64(conns)
		case "traffic_in_rate":
			value = float64(pt.In) / float64(stepSec)
		case "traffic_out_rate":
			value = float64(pt.Out) / float64(stepSec)
		default:
			continue
		}
		s.applyRule(r, instID, target, value, now)
	}
}

func (s *Sampler) applyRule(r AlertRule, instID, target string, value float64, now int64) {
	st := s.alerts[r.ID]
	if st == nil {
		st = &alertState{}
		s.alerts[r.ID] = st
	}
	breached := compare(value, r.Op, r.Threshold)
	if breached {
		if st.firingSince == 0 {
			st.firingSince = now
		}
		held := now - st.firingSince
		if !st.fired && held >= int64(r.ForSeconds) {
			st.fired = true
			ev := AlertEvent{
				ID:     fmt.Sprintf("ae_%s_%d", r.ID, now),
				RuleID: r.ID, InstID: instID, Target: target,
				FiredAt: now, Value: value, State: "firing",
			}
			_ = s.store.InsertEvent(ev)
			s.publishAlert(ev, r)
		}
	} else {
		if st.fired {
			st.fired = false
			_ = s.store.ResolveEvent(r.ID, now)
			ev := AlertEvent{
				ID:     fmt.Sprintf("ae_%s_%d_r", r.ID, now),
				RuleID: r.ID, InstID: instID, Target: target,
				FiredAt: st.firingSince, ResolvedAt: now, Value: value, State: "resolved",
			}
			s.publishAlert(ev, r)
		}
		st.firingSince = 0
	}
}

func compare(v float64, op string, th float64) bool {
	switch op {
	case ">":
		return v > th
	case ">=":
		return v >= th
	case "<":
		return v < th
	case "<=":
		return v <= th
	}
	return false
}

// publishAlert emits an eventbus event and, if configured, POSTs a webhook.
func (s *Sampler) publishAlert(ev AlertEvent, r AlertRule) {
	if s.bus != nil {
		s.bus.Publish(eventbus.TypeAlert, ev.InstID, map[string]any{
			"rule_id": ev.RuleID, "rule_name": r.Name, "target": ev.Target,
			"state": ev.State, "value": ev.Value, "threshold": r.Threshold,
			"metric": r.Metric, "fired_at": ev.FiredAt, "resolved_at": ev.ResolvedAt,
		})
	}
	if r.Webhook != "" {
		go s.postWebhook(r.Webhook, ev, r)
	}
}

func (s *Sampler) postWebhook(url string, ev AlertEvent, r AlertRule) {
	payload, _ := json.Marshal(map[string]any{
		"rule_id": ev.RuleID, "rule_name": r.Name, "inst_id": ev.InstID,
		"target": ev.Target, "metric": r.Metric, "op": r.Op, "threshold": r.Threshold,
		"value": ev.Value, "state": ev.State, "fired_at": ev.FiredAt, "resolved_at": ev.ResolvedAt,
	})
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		s.log.Warn("alert webhook failed", slog.String("rule", r.ID), slog.Any("err", err))
		return
	}
	_ = resp.Body.Close()
}

// ensure strconv stays imported for potential numeric parsing helpers.
var _ = strconv.Itoa
