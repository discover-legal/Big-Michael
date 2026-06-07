// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Discover Legal

// Inputs for the budget and docket monitors: setting a matter's budget (so budget
// burn + threshold alerts have something to measure against) and registering
// court dockets to watch. Both are partner-gated.
package api

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/discover-legal/biglaw-go/internal/clients"
	"github.com/discover-legal/biglaw-go/internal/dockets"
	"github.com/discover-legal/biglaw-go/internal/timekeeping"
	"github.com/discover-legal/biglaw-go/internal/types"
)

// apiBudgetTime adapts the time store to the budget TimeStore interface.
type apiBudgetTime struct{ ts *timekeeping.TimeStore }

func (a apiBudgetTime) List(matter string) []types.TimeEntry {
	return a.ts.List(timekeeping.TimeFilter{MatterNumber: matter})
}
func (a apiBudgetTime) ListAll() []types.TimeEntry { return a.ts.List(timekeeping.TimeFilter{}) }

// apiBudgetClients adapts the client roster to the budget ClientStore interface.
type apiBudgetClients struct{ cs *clients.ClientStore }

func (a apiBudgetClients) List() []*types.Client {
	src := a.cs.List()
	out := make([]*types.Client, len(src))
	for i := range src {
		c := src[i]
		out[i] = &c
	}
	return out
}
func (a apiBudgetClients) SetMatterBudgetAlerts(matterNumber string, triggered []float64) error {
	return a.cs.SetMatterBudgetAlerts(matterNumber, triggered)
}

// mountMatterBudget registers the matter-budget endpoint. Called from New().
func (s *Server) mountMatterBudget(r *gin.Engine) {
	// Set/clear a matter's budget (+ optional alert thresholds).
	r.PUT("/matters/:mn/budget", func(c *gin.Context) {
		if !requirePartner(c) {
			return
		}
		var body struct {
			BudgetUsd  *float64  `json:"budgetUsd"`
			Thresholds []float64 `json:"thresholds"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body: " + err.Error()})
			return
		}
		if err := s.clients.SetMatterBudget(c.Param("mn"), body.BudgetUsd, body.Thresholds); err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"matterNumber": c.Param("mn"), "budgetUsd": body.BudgetUsd})
	})
}

// AttachDockets registers docket-watch management endpoints backed by the running
// monitor. No-op when the docket monitor is disabled.
func (s *Server) AttachDockets(dm *dockets.Monitor) {
	if dm == nil {
		return
	}
	s.dockets = dm // expose to the bot facade (watch/unwatch/dockets commands)
	g := s.router.Group("/dockets")
	g.Use(func(c *gin.Context) {
		if !requirePartner(c) {
			c.Abort()
		}
	})
	g.GET("", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"dockets": dm.List()})
	})
	g.POST("", func(c *gin.Context) {
		var body struct {
			MatterNumber string `json:"matterNumber"`
			DocketNumber string `json:"docketNumber"`
			Court        string `json:"court"`
			CaseName     string `json:"caseName"`
		}
		if err := c.ShouldBindJSON(&body); err != nil || body.MatterNumber == "" || body.DocketNumber == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "matterNumber and docketNumber required"})
			return
		}
		w, err := dm.Watch(body.MatterNumber, body.DocketNumber, body.Court, body.CaseName)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, w)
	})
	g.DELETE("/:mn", func(c *gin.Context) {
		if !dm.Unwatch(c.Param("mn")) {
			c.JSON(http.StatusNotFound, gin.H{"error": "not watched"})
			return
		}
		c.Status(http.StatusNoContent)
	})
}
