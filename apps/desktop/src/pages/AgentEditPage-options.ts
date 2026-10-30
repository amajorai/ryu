import type { LiteralMessage } from "@ryu/i18n/react";
import type { SchedulePhrase } from "@/src/lib/automations.ts";

export type ToneOption =
	| "neutral"
	| "professional"
	| "friendly"
	| "pirate"
	| "custom";

export const TONE_OPTIONS: { value: ToneOption; label: string }[] = [
	{ value: "neutral", label: "Neutral (default)" },
	{ value: "professional", label: "Professional" },
	{ value: "friendly", label: "Friendly" },
	{ value: "pirate", label: "Pirate" },
	{ value: "custom", label: "Custom" },
];

/** Client-only sentinel for an agent that does not use a reusable profile. */
export const AGENT_OWN_VOICE_PROFILE = "__agent_own_voice__";

// ── Fallback tool list (used when GET /api/mcp/tools returns empty) ───────────
// Core's agent allowlist matches a tool id, bare tool name, or owning server, so
// the fallback offers built-in server names that always resolve.

export const FALLBACK_TOOLS = [
	"web",
	"web_fetch",
	"browser",
	"memory",
	"spaces",
	"artifact",
	"sandbox",
];

// Schedule phrase → workflow conversion lives in `lib/automations.ts` (shared
// with the calendar's New automation dialog). `SchedulePhrase` and
// `phraseToSchedule` are imported above.

// ── Preview label derivations ─────────────────────────────────────────────────

export function toneLabel(tone: ToneOption, customTone: string): string | null {
	if (tone === "neutral") {
		return null;
	}
	if (tone === "custom") {
		return customTone.trim() || null;
	}
	return TONE_OPTIONS.find((o) => o.value === tone)?.label ?? null;
}

export function scheduleSummary(
	enabled: boolean,
	phrase: SchedulePhrase,
	dailyTime: string,
	weeklyDay: string,
	weeklyTime: string,
	tl: LiteralMessage
): string | null {
	if (!enabled) {
		return null;
	}
	if (phrase === "everyminute") {
		return "Runs every minute";
	}
	if (phrase === "hourly") {
		return "Runs hourly";
	}
	if (phrase === "daily") {
		return tl("Runs daily at {dailyTime}", { dailyTime });
	}
	if (phrase === "weekdays") {
		return tl("Runs weekdays at {dailyTime}", { dailyTime });
	}
	if (phrase === "weekends") {
		return tl("Runs weekends at {dailyTime}", { dailyTime });
	}
	if (phrase === "weekly") {
		const day = weeklyDay.charAt(0).toUpperCase() + weeklyDay.slice(1);
		return tl("Runs weekly · {day} {weeklyTime}", { day, weeklyTime });
	}
	return "Custom schedule";
}

// ── Main page ──────────────────────────────────────────────────────────────────

/** Engine-picker sentinel for the BYO "Custom ACP command…" option. */
export const ACP_CUSTOM_ENGINE = "__acp_exec_custom__";
/** Engine prefix Core treats as a literal ACP spawn command (`agent_route`). */
export const ACP_EXEC_PREFIX = "acp-exec:";

export function isInstalledChatModel(
	chatModel: string,
	installedAgentEngineIds: Set<string>
): boolean {
	return (
		chatModel === ACP_CUSTOM_ENGINE || installedAgentEngineIds.has(chatModel)
	);
}

export function saveBlockedMessage(
	installedAgentEngineCount: number,
	selectedUninstalledAgent: boolean
): string | null {
	if (installedAgentEngineCount === 0) {
		return "No agents are installed yet, so there's nothing to run this agent. Install an agent to turn on saving.";
	}
	if (selectedUninstalledAgent) {
		return "This agent is not installed yet. Add it from the agent catalog before selecting it here.";
	}
	return null;
}

// This is an advisory signal for the local scorecard, not an authorization
// check. Core and Gateway remain the authorities that classify and enforce tool
// effects; the editor only helps a person notice a broad or write-capable setup.
const HIGH_IMPACT_TOOL_RE =
	/(?:^|[._:-])(write|delete|remove|update|create|send|publish|execute|exec|run|post|patch|put)(?:$|[._:-])/i;

export function isHighImpactTool(toolName: string): boolean {
	return HIGH_IMPACT_TOOL_RE.test(toolName);
}
