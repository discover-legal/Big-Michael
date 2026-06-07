// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Discover Legal

// ConflictGraph — HTTP client to the TypeDB sidecar (sidecar/typedb/).
//
// The TypeDB Go driver does not exist; instead the sidecar process owns the
// TypeDB connection and exposes a minimal HTTP API on TYPEDB_SIDECAR_URL
// (default http://127.0.0.1:3102). This package is a thin HTTP client over
// that API — no in-memory fallback, no approximation.
//
// If the sidecar is unreachable, all methods return an error. The caller
// (clients package, orchestrator) decides whether to surface or swallow it.

package graph

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/discover-legal/biglaw-go/internal/types"
)

const defaultSidecarURL = "http://127.0.0.1:3102"

// Client calls the TypeDB sidecar over HTTP.
type Client struct {
	base   string
	http   *http.Client
}

// New creates a Client. The sidecar URL is read from TYPEDB_SIDECAR_URL.
func New() *Client {
	base := os.Getenv("TYPEDB_SIDECAR_URL")
	if base == "" {
		base = defaultSidecarURL
	}
	return &Client{
		base: base,
		http: &http.Client{Timeout: 30 * time.Second},
	}
}

// Ping checks the sidecar health endpoint.
func (c *Client) Ping() error {
	resp, err := c.http.Get(c.base + "/health")
	if err != nil {
		return fmt.Errorf("typedb sidecar unreachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("typedb sidecar unhealthy: HTTP %d", resp.StatusCode)
	}
	var body struct {
		OK        bool `json:"ok"`
		Connected bool `json:"connected"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64*1024)).Decode(&body); err != nil {
		return fmt.Errorf("typedb sidecar: bad health response: %w", err)
	}
	if !body.Connected {
		slog.Warn("graph: TypeDB sidecar running but not yet connected to TypeDB")
	}
	return nil
}

// SyncInput is the payload for /sync.
type SyncInput struct {
	Clients []SyncClient `json:"clients"`
	Matters []SyncMatter `json:"matters"`
}

type SyncClient struct {
	ID          string      `json:"id"`
	Name        string      `json:"name"`
	Adversaries []string    `json:"adversaries"`
	Matters     []MatterRef `json:"matters"`
}

type MatterRef struct {
	MatterNumber string `json:"matterNumber"`
	PracticeArea string `json:"practiceArea,omitempty"`
}

type SyncMatter struct {
	MatterNumber string `json:"matterNumber"`
	PracticeArea string `json:"practiceArea,omitempty"`
	Jurisdiction string `json:"jurisdiction,omitempty"`
	Status       string `json:"status,omitempty"`
}

// Sync pushes all clients and matters to the sidecar for graph rebuild.
func (c *Client) Sync(input SyncInput) error {
	return c.post("/sync", input, nil)
}

// CheckClient returns all conflicts touching clientId.
func (c *Client) CheckClient(clientId string) ([]types.ConflictReport, error) {
	resp, err := c.http.Get(c.base + "/conflicts?clientId=" + clientId)
	if err != nil {
		return nil, fmt.Errorf("graph: CheckClient request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == 503 {
		return nil, fmt.Errorf("graph: TypeDB not connected")
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("graph: CheckClient HTTP %d", resp.StatusCode)
	}
	var out []types.ConflictReport
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out); err != nil {
		return nil, fmt.Errorf("graph: CheckClient decode: %w", err)
	}
	return out, nil
}

// CheckNewMatter simulates adding adversaryIds for clientId and returns
// any conflicts that would arise. Does NOT write to the graph.
func (c *Client) CheckNewMatter(clientId string, adversaryIds []string) ([]types.ConflictReport, error) {
	body := map[string]any{
		"clientId":     clientId,
		"adversaryIds": adversaryIds,
	}
	var out []types.ConflictReport
	if err := c.post("/check-new-matter", body, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ─── internal ─────────────────────────────────────────────────────────────────

func (c *Client) post(path string, payload any, out any) error {
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	resp, err := c.http.Post(c.base+path, "application/json", bytes.NewReader(b))
	if err != nil {
		return fmt.Errorf("graph: POST %s failed: %w", path, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode == 503 {
		return fmt.Errorf("graph: TypeDB not connected")
	}
	if resp.StatusCode != 200 {
		return fmt.Errorf("graph: POST %s HTTP %d: %s", path, resp.StatusCode, raw)
	}
	if out != nil {
		return json.Unmarshal(raw, out)
	}
	return nil
}
