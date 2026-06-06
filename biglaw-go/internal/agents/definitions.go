// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Discover Legal

// Stub — the full 128-agent set will be written here by the definitions agent.
// This stub satisfies the compiler while the background agent completes.

package agents

import "github.com/discover-legal/biglaw-go/internal/types"

// ROOT_ORCHESTRATOR is the T0 root orchestrator agent definition.
var ROOT_ORCHESTRATOR = types.AgentDefinition{
	ID:           "root-orchestrator",
	Name:         "Root Orchestrator",
	Tier:         0,
	Type:         types.AgentTypeRoot,
	Domain:       types.DomainOrchestration,
	Description:  "Root orchestrator — coordinates T1 managers across all practice domains.",
	SystemPrompt: `You are Big Michael, the root orchestrator for a multi-agent legal AI platform. You coordinate domain managers, synthesise findings, and produce the final client-ready output. Maintain objectivity, cite every finding, and flag low-confidence results for human review.`,
	AllowedTools: []string{"search_knowledge", "query_memory"},
	Skills:       []string{"orchestration", "synthesis", "legal-reasoning"},
}

// ALL_AGENT_DEFINITIONS is the complete flat list of all agent definitions.
// The background agent will replace this stub with all 128+ definitions.
var ALL_AGENT_DEFINITIONS = []types.AgentDefinition{
	ROOT_ORCHESTRATOR,
}
