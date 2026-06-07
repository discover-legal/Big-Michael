// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Discover Legal

// Firm-wide background monitors: budget threshold alerts, court-docket polling,
// and the regulatory pulse. Each is gated by its own flag (regulatory auto-enables
// only when TAVILY_API_KEY is set). Alerts are posted to the matter's chat channel
// when one is configured and always written to the append-only audit log.
package main

import (
	"fmt"
	"log/slog"
	"time"

	"github.com/discover-legal/biglaw-go/internal/audit"
	"github.com/discover-legal/biglaw-go/internal/budget"
	"github.com/discover-legal/biglaw-go/internal/clients"
	"github.com/discover-legal/biglaw-go/internal/config"
	"github.com/discover-legal/biglaw-go/internal/dockets"
	"github.com/discover-legal/biglaw-go/internal/lpm"
	"github.com/discover-legal/biglaw-go/internal/orchestrator"
	"github.com/discover-legal/biglaw-go/internal/providers"
	"github.com/discover-legal/biglaw-go/internal/regulatory"
	"github.com/discover-legal/biglaw-go/internal/routing"
	"github.com/discover-legal/biglaw-go/internal/timekeeping"
	"github.com/discover-legal/biglaw-go/internal/types"
)

// startMonitors constructs and starts the enabled monitors, returning a stop
// function that halts them all.
func startMonitors(
	cfg *config.Config,
	orch *orchestrator.Orchestrator,
	ts *timekeeping.TimeStore,
	cs *clients.ClientStore,
	provReg *providers.Registry,
) func() {
	poster := newMatterChannelPoster(cfg)
	var stops []func()

	if cfg.Monitors.BudgetAlertsEnabled {
		bm := budget.NewMonitor(tsAdapter{ts}, budgetClientStore{cs}, func(a types.BudgetAlert) {
			postAlert(poster, "budget_alert", a.MatterNumber,
				fmt.Sprintf("Budget alert — %s", a.MatterNumber),
				fmt.Sprintf("Matter %s has burned %.0f%% of its $%.0f budget ($%.0f spent).",
					a.MatterNumber, a.BurnPct*100, a.BudgetUsd, a.BurnUsd),
				map[string]interface{}{"threshold": a.Threshold, "burnPct": a.BurnPct, "budgetUsd": a.BudgetUsd})
		})
		bm.Start(minutes(cfg.Monitors.BudgetIntervalMin), func() []string { return activeMatterNumbers(orch) })
		stops = append(stops, bm.Stop)
	}

	if cfg.Monitors.DocketsEnabled {
		dm := dockets.New(cfg.Monitors.DocketsFile)
		if err := dm.Init(); err != nil {
			slog.Warn("docket monitor init failed", "error", err)
		}
		dm.SetAlertHandler(func(a types.DocketAlert) {
			postAlert(poster, "docket_alert", a.MatterNumber,
				fmt.Sprintf("New docket activity — %s", a.CaseName),
				fmt.Sprintf("%d new filing(s) on %s (%s). Latest: %s\n%s",
					a.NewFilingCount, a.DocketNumber, a.Court, a.LatestFilingDate, a.CourtListenerURL),
				map[string]interface{}{"docketNumber": a.DocketNumber, "newFilings": a.NewFilingCount})
		})
		dm.Start(minutes(cfg.Monitors.DocketsIntervalMin))
		stops = append(stops, dm.Stop)
	}

	rm := regulatory.New(provReg.MustGet(routing.ModelHaiku), routing.ModelHaiku)
	if rm.IsEnabled() {
		rm.SetAlertHandler(func(a types.RegulationAlert) {
			postAlert(poster, "regulatory_alert", a.MatterNumber,
				fmt.Sprintf("Regulatory update — %s", a.PracticeArea),
				fmt.Sprintf("%s\n%s\n%s", a.Headline, a.Summary, a.URL),
				map[string]interface{}{"practiceArea": a.PracticeArea, "jurisdiction": a.Jurisdiction})
		})
		rm.Start(minutes(cfg.Monitors.RegulatoryIntervalMin), func() []types.Task { return openTasks(orch) })
		stops = append(stops, rm.Stop)
		slog.Info("regulatory pulse monitor enabled")
	}

	return func() {
		for _, stop := range stops {
			stop()
		}
	}
}

// postAlert audits an alert and posts it to the matter channel when configured.
func postAlert(poster lpm.ChannelPoster, event, matter, subject, body string, data map[string]interface{}) {
	if data == nil {
		data = map[string]interface{}{}
	}
	data["matterNumber"] = matter
	audit.Default.Write(audit.WriteRequest{Event: event, ActorID: "monitor", Data: data})
	if poster == nil || matter == "" {
		return
	}
	if err := poster(lpm.Draft{MatterNumber: matter, Subject: subject, Body: body}); err != nil {
		slog.Warn("alert channel post failed", "event", event, "matter", matter, "error", err)
	}
}

func minutes(n int) time.Duration {
	if n <= 0 {
		n = 60
	}
	return time.Duration(n) * time.Minute
}

func activeMatterNumbers(orch *orchestrator.Orchestrator) []string {
	seen := map[string]bool{}
	var out []string
	for _, t := range orch.ListTasks() {
		if t == nil || t.MatterNumber == "" || seen[t.MatterNumber] {
			continue
		}
		if t.Status == types.TaskStatusComplete || t.Status == types.TaskStatusFailed {
			continue
		}
		seen[t.MatterNumber] = true
		out = append(out, t.MatterNumber)
	}
	return out
}

func openTasks(orch *orchestrator.Orchestrator) []types.Task {
	var out []types.Task
	for _, t := range orch.ListTasks() {
		if t == nil {
			continue
		}
		if t.Status == types.TaskStatusComplete || t.Status == types.TaskStatusFailed {
			continue
		}
		out = append(out, *t)
	}
	return out
}
