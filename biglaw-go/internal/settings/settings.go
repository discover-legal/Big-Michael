// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Discover Legal

package settings

import (
	"encoding/json"
	"os"
	"sync"
)

// AdminSettings holds all runtime-overrideable configuration fields.
// Zero values are treated as "unset" and are not merged over existing values.
type AdminSettings struct {
	DyTopoMaxAgentsPerRound   int     `json:"dytopoMaxAgentsPerRound,omitempty"`
	DyTopoSimilarityThreshold float64 `json:"dytopoSimilarityThreshold,omitempty"`
	DebateAdversarialEnabled  bool    `json:"debateAdversarialEnabled"`
	DebateCitationRequired    bool    `json:"debateCitationRequired"`
	DebateVerificationPasses  int     `json:"debateVerificationPasses,omitempty"`
	DebateGateThreshold       float64 `json:"debateGateThreshold,omitempty"`
	AnthropicModel            string  `json:"anthropicModel,omitempty"`
	MaxRounds                 int     `json:"maxRounds,omitempty"`
}

// SettingsStore is a thread-safe store for AdminSettings that persists to a
// JSON file on disk using an atomic write (write-to-tmp then rename).
type SettingsStore struct {
	mu       sync.RWMutex
	current  AdminSettings
	path     string
}

// NewSettingsStore creates a SettingsStore that will persist to path.
// Call Init to load any previously persisted settings.
func NewSettingsStore(path string) *SettingsStore {
	return &SettingsStore{path: path}
}

// Init loads settings from the JSON file at the store's path.
// A missing file is silently ignored; any other error is returned.
func (s *SettingsStore) Init() error {
	data, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	var loaded AdminSettings
	if err := json.Unmarshal(data, &loaded); err != nil {
		return err
	}

	s.mu.Lock()
	s.current = loaded
	s.mu.Unlock()
	return nil
}

// Get returns a copy of the current AdminSettings under a read lock.
func (s *SettingsStore) Get() AdminSettings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.current
}

// Update merges non-zero fields from patch into the current settings,
// persists the result to disk, and returns the merged AdminSettings.
func (s *SettingsStore) Update(patch AdminSettings) AdminSettings {
	s.mu.Lock()
	defer s.mu.Unlock()

	if patch.DyTopoMaxAgentsPerRound != 0 {
		s.current.DyTopoMaxAgentsPerRound = patch.DyTopoMaxAgentsPerRound
	}
	if patch.DyTopoSimilarityThreshold != 0 {
		s.current.DyTopoSimilarityThreshold = patch.DyTopoSimilarityThreshold
	}
	// bool fields: always overwrite from patch (zero value false is a valid setting)
	s.current.DebateAdversarialEnabled = patch.DebateAdversarialEnabled
	s.current.DebateCitationRequired = patch.DebateCitationRequired

	if patch.DebateVerificationPasses != 0 {
		s.current.DebateVerificationPasses = patch.DebateVerificationPasses
	}
	if patch.DebateGateThreshold != 0 {
		s.current.DebateGateThreshold = patch.DebateGateThreshold
	}
	if patch.AnthropicModel != "" {
		s.current.AnthropicModel = patch.AnthropicModel
	}
	if patch.MaxRounds != 0 {
		s.current.MaxRounds = patch.MaxRounds
	}

	// Best-effort persist; ignore error so callers don't fail on disk issues.
	_ = s.persist()

	return s.current
}

// persist writes the current settings to disk atomically:
// it marshals to a temp file (path+".tmp") then renames it over path.
// Must be called with s.mu held (at least for read).
func (s *SettingsStore) persist() error {
	data, err := json.MarshalIndent(s.current, "", "  ")
	if err != nil {
		return err
	}

	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}
