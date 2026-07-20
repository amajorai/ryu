// apps/desktop/src/lib/api/healing.ts
//
// Typed client for Core's self-healing surface (`/api/healing/*`): the loop that
// diagnoses failed runs and either auto-applies a fix or queues it in the
// approvals inbox. Field names are snake_case to match Core's serde shapes.

import { type ApiTarget, request } from "./client.ts";

/** Resolved healing config (mirrors Core's `HealingConfigView`). */
export interface HealingConfig {
	auto_decide: boolean;
	cooldown_secs: number;
	diagnose_effort: string;
	diagnose_model: string;
	enabled: boolean;
	max_attempts: number;
}

/** Partial patch accepted by `POST /api/healing/config`. */
export interface HealingConfigPatch {
	auto_decide?: boolean;
	cooldown_secs?: number;
	diagnose_effort?: string;
	diagnose_model?: string;
	enabled?: boolean;
	max_attempts?: number;
}

/** Per-source heal bookkeeping (mirrors Core's `HealAttempt`). */
export interface HealAttempt {
	count: number;
	given_up: boolean;
	/** Unix millis of the last heal for this source. */
	last_at: number;
}

export interface HealingStatus {
	/** Keyed by source id (a conversation id, `job:<id>`, or a workflow run id). */
	attempts: Record<string, HealAttempt>;
}

/** Read the resolved healing config. */
export function getHealingConfig(target: ApiTarget): Promise<HealingConfig> {
	return request<HealingConfig>(target, "/api/healing/config");
}

/** Read the in-memory per-source heal-attempt map (history/observability). */
export function getHealingStatus(target: ApiTarget): Promise<HealingStatus> {
	return request<HealingStatus>(target, "/api/healing/status");
}

/** Set any subset of the healing config; returns the newly-resolved config. */
export function setHealingConfig(
	target: ApiTarget,
	patch: HealingConfigPatch
): Promise<HealingConfig> {
	return request<HealingConfig>(target, "/api/healing/config", {
		method: "POST",
		body: patch,
	});
}
