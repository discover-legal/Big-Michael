// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Discover Legal

// Tests for the COST_<FAMILY>_IN/_OUT pricing env overrides.

package cost

import "testing"

// samplePricing returns a fresh copy of a representative pricing table so
// tests never mutate the package-level basePricing.
func samplePricing() map[string][2]float64 {
	return map[string][2]float64{
		"claude-haiku-4-5":          {1.00, 5.00},
		"claude-3-5-haiku-20241022": {1.00, 5.00},
		"claude-sonnet-4-6":         {3.00, 15.00},
		"claude-opus-4-8":           {15.00, 75.00},
	}
}

func TestApplyPricingEnvOverrides_Family(t *testing.T) {
	t.Setenv("COST_HAIKU_IN", "2.50")
	t.Setenv("COST_HAIKU_OUT", "12.50")

	pricing := samplePricing()
	applyPricingEnvOverrides(pricing)

	// Every model containing "haiku" gets the override.
	for _, model := range []string{"claude-haiku-4-5", "claude-3-5-haiku-20241022"} {
		if got := pricing[model]; got != [2]float64{2.50, 12.50} {
			t.Errorf("%s = %v, want {2.5 12.5}", model, got)
		}
	}
	// Other families untouched.
	if got := pricing["claude-sonnet-4-6"]; got != [2]float64{3.00, 15.00} {
		t.Errorf("sonnet changed unexpectedly: %v", got)
	}
	if got := pricing["claude-opus-4-8"]; got != [2]float64{15.00, 75.00} {
		t.Errorf("opus changed unexpectedly: %v", got)
	}
}

func TestApplyPricingEnvOverrides_PartialOverride(t *testing.T) {
	// Only the input rate is overridden; the output rate keeps its default.
	t.Setenv("COST_SONNET_IN", "6")

	pricing := samplePricing()
	applyPricingEnvOverrides(pricing)

	if got := pricing["claude-sonnet-4-6"]; got != [2]float64{6.00, 15.00} {
		t.Errorf("claude-sonnet-4-6 = %v, want {6 15}", got)
	}
}

func TestApplyPricingEnvOverrides_InvalidValuesIgnored(t *testing.T) {
	t.Setenv("COST_OPUS_IN", "not-a-number")
	t.Setenv("COST_OPUS_OUT", "-1")

	pricing := samplePricing()
	applyPricingEnvOverrides(pricing)

	if got := pricing["claude-opus-4-8"]; got != [2]float64{15.00, 75.00} {
		t.Errorf("invalid override applied: %v, want {15 75}", got)
	}
}

func TestApplyPricingEnvOverrides_NoEnvNoChange(t *testing.T) {
	// Ensure unrelated env state doesn't bleed in.
	t.Setenv("COST_HAIKU_IN", "")
	t.Setenv("COST_HAIKU_OUT", "")

	pricing := samplePricing()
	applyPricingEnvOverrides(pricing)

	want := samplePricing()
	for model, p := range want {
		if pricing[model] != p {
			t.Errorf("%s = %v, want %v", model, pricing[model], p)
		}
	}
}

func TestParsePriceEnv(t *testing.T) {
	t.Setenv("COST_TEST_RATE", " 4.25 ")
	if v, ok := parsePriceEnv("COST_TEST_RATE"); !ok || v != 4.25 {
		t.Errorf("parsePriceEnv = %v, %v; want 4.25, true", v, ok)
	}
	if _, ok := parsePriceEnv("COST_TEST_UNSET_RATE"); ok {
		t.Error("unset env var parsed as valid")
	}
}
