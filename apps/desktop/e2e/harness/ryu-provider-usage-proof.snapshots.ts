// Core's `GET /api/agents/<id>/usage` answers for the provider usage proof,
// typed by the core-client wire schema the Desktop client parses them with.
// The spec serves them through page.route, so the proof needs no live Core.
import {
	type UsageSnapshotWire,
	usageSnapshotWireSchema,
} from "@ryuhq/core-client/usage.ts";

const snapshots: Record<string, UsageSnapshotWire> = {
	"acp:claude": {
		agent_id: "acp:claude",
		available: true,
		engine: "claude",
		extra_usage_usd: null,
		meters: [],
		plan: "Max 20x",
		reason: null,
		retry_after_seconds: null,
		windows: [
			{
				label: "Session",
				model: null,
				resets_at: "2026-08-17T18:00:00Z",
				used_percent: 28,
				window_seconds: 18_000,
			},
			{
				label: "Weekly",
				model: null,
				resets_at: "2026-08-24T00:00:00Z",
				used_percent: 62,
				window_seconds: 604_800,
			},
		],
	},
	"claude-pro-max": {
		agent_id: "claude-pro-max",
		available: true,
		engine: "claude",
		extra_usage_usd: null,
		meters: [],
		plan: "Max 20x",
		reason: null,
		retry_after_seconds: null,
		windows: [
			{
				label: "Session",
				model: null,
				resets_at: "2026-08-17T18:00:00Z",
				used_percent: 34,
				window_seconds: 18_000,
			},
			{
				label: "Weekly",
				model: null,
				resets_at: "2026-08-24T00:00:00Z",
				used_percent: 58,
				window_seconds: 604_800,
			},
		],
	},
	"openai-codex": {
		agent_id: "openai-codex",
		available: true,
		engine: "codex",
		extra_usage_usd: null,
		meters: [
			{
				expires_at: ["2026-08-18T18:00:00Z"],
				label: "Rate limit resets",
				resets_at: "2026-08-18T18:00:00Z",
				values: [
					{ kind: "count", number: 3, unit: "available" },
					{ kind: "count", number: 10, unit: "cap" },
				],
			},
		],
		plan: "Plus",
		reason: null,
		retry_after_seconds: null,
		windows: [
			{
				label: "Session",
				model: null,
				resets_at: "2026-08-17T18:00:00Z",
				used_percent: 41,
				window_seconds: 18_000,
			},
			{
				label: "Weekly",
				model: null,
				resets_at: "2026-08-24T00:00:00Z",
				used_percent: 73,
				window_seconds: 604_800,
			},
		],
	},
	"github-copilot": {
		agent_id: "github-copilot",
		available: true,
		engine: "copilot",
		extra_usage_usd: null,
		meters: [],
		plan: "Pro",
		reason: null,
		retry_after_seconds: null,
		windows: [
			{
				label: "Credits",
				model: null,
				resets_at: "2026-09-01T00:00:00Z",
				used_percent: 19,
				window_seconds: 2_592_000,
			},
		],
	},
	"acp:devin": {
		agent_id: "acp:devin",
		available: true,
		engine: "devin",
		extra_usage_usd: null,
		meters: [
			{
				expires_at: [],
				label: "Extra usage balance",
				resets_at: null,
				values: [{ kind: "dollars", number: 12.5, unit: null }],
			},
		],
		plan: "Max",
		reason: null,
		retry_after_seconds: null,
		windows: [
			{
				label: "Daily quota",
				model: null,
				resets_at: "2026-09-24T00:00:00Z",
				used_percent: 28,
				window_seconds: 86_400,
			},
			{
				label: "Weekly quota",
				model: null,
				resets_at: "2026-09-28T00:00:00Z",
				used_percent: 52,
				window_seconds: 604_800,
			},
		],
	},
	"acp:opencode": {
		agent_id: "acp:opencode",
		available: true,
		engine: "opencode",
		extra_usage_usd: null,
		meters: [],
		plan: "Go",
		reason: null,
		retry_after_seconds: null,
		windows: [
			{
				label: "Session",
				model: null,
				resets_at: "2026-09-23T13:00:00Z",
				used_percent: 17,
				window_seconds: null,
			},
			{
				label: "Weekly",
				model: null,
				resets_at: "2026-09-28T00:00:00Z",
				used_percent: 7,
				window_seconds: null,
			},
			{
				label: "Monthly",
				model: null,
				resets_at: "2026-10-01T00:00:00Z",
				used_percent: 3,
				window_seconds: null,
			},
		],
	},
	"acp:ollama": {
		agent_id: "acp:ollama",
		available: true,
		engine: "ollama",
		extra_usage_usd: null,
		meters: [
			{
				expires_at: [],
				label: "Last 4 weeks",
				resets_at: null,
				values: [{ kind: "dollars", number: 2.75, unit: null }],
			},
		],
		plan: null,
		reason: null,
		retry_after_seconds: null,
		windows: [
			{
				label: "Session",
				model: null,
				resets_at: null,
				used_percent: 34.9,
				window_seconds: 18_000,
			},
			{
				label: "Weekly",
				model: null,
				resets_at: null,
				used_percent: 12,
				window_seconds: 604_800,
			},
		],
	},
	"acp:cursor": {
		agent_id: "acp:cursor",
		available: true,
		engine: "cursor",
		extra_usage_usd: null,
		meters: [
			{
				expires_at: [],
				label: "On-demand",
				resets_at: null,
				values: [
					{ kind: "dollars", number: 4, unit: null },
					{ kind: "dollars", number: 10, unit: null },
				],
			},
			{
				expires_at: [],
				label: "Credits",
				resets_at: null,
				values: [{ kind: "dollars", number: 63, unit: null }],
			},
			{
				expires_at: [],
				label: "Requests",
				resets_at: null,
				values: [
					{ kind: "count", number: 39, unit: "requests" },
					{ kind: "count", number: 500, unit: "requests" },
				],
			},
		],
		plan: "Pro",
		reason: null,
		retry_after_seconds: null,
		windows: [
			{
				label: "Total usage",
				model: null,
				resets_at: "2026-10-01T00:00:00Z",
				used_percent: 10,
				window_seconds: 2_592_000,
			},
			{
				label: "Cursor Models",
				model: null,
				resets_at: "2026-10-01T00:00:00Z",
				used_percent: 15,
				window_seconds: 2_592_000,
			},
			{
				label: "Other Models",
				model: null,
				resets_at: "2026-10-01T00:00:00Z",
				used_percent: 35,
				window_seconds: 2_592_000,
			},
			{
				label: "Grok Bot usage",
				model: null,
				resets_at: "2026-10-01T00:00:00Z",
				used_percent: 42,
				window_seconds: 604_800,
			},
		],
	},
	"acp:gemini": {
		agent_id: "acp:gemini",
		available: true,
		engine: "antigravity",
		extra_usage_usd: null,
		meters: [],
		plan: "Ultra",
		reason: null,
		retry_after_seconds: null,
		windows: [
			{
				label: "Session",
				model: null,
				resets_at: "2026-09-23T16:00:00Z",
				used_percent: 32,
				window_seconds: 18_000,
			},
			{
				label: "Weekly",
				model: null,
				resets_at: "2026-09-28T00:00:00Z",
				used_percent: 49,
				window_seconds: 604_800,
			},
			{
				label: "Claude",
				model: null,
				resets_at: "2026-09-23T16:00:00Z",
				used_percent: 20,
				window_seconds: 18_000,
			},
		],
	},
};

/** The wire snapshot Core would return for `agentId`, validated by its schema. */
export function usageSnapshotFor(agentId: string): UsageSnapshotWire | null {
	const snapshot = snapshots[agentId];
	return snapshot ? usageSnapshotWireSchema.parse(snapshot) : null;
}
