import { AgentCatalogLogo } from "@/src/lib/agent-catalog-logo.tsx";
import { track } from "@/src/lib/analytics.ts";
import {
	type AgentCatalogEntry,
	fetchAgentCatalog,
} from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { isUnauthorized } from "./OnboardingPage.local-stack.ts";

// Attach the resolved brand logo to each catalog entry so the shared onboarding
// AgentRow can render it next to the name — the presentational block can't reach
// the desktop's `AgentCatalogLogo` (local engine → SVGL → ACP CDN → Ryu fallback).
export const withAgentLogo = (entry: AgentCatalogEntry) => ({
	...entry,
	logo: <AgentCatalogLogo entry={entry} size="20px" />,
});

// The agent catalog gets a longer one: Core spawns a `--version` probe per agent
// (and an npm lookup per bridge), each bounded at 30s on its side.
export const AGENT_CATALOG_TIMEOUT_MS = 60 * 1000;

// The curated set of third-party agents worth surfacing on first run. Anything
// detectable but not on this list is too niche for onboarding and is hidden.
// Ids are matched against the live catalog and the live row wins whenever there
// is one — it carries the description, icon and `detected`/`added` flags. But a
// curated agent the catalog does NOT mention still renders, from the static row
// below (see the union in `loadOnboardingAgents`). This list is curation, and the
// catalog is a remote-registry fetch that can come back partial or not at all;
// letting that decide what onboarding offers is what made "Add your agents" show
// up empty on a machine with no agents installed — exactly the machine that needs
// the suggestions most.
export const SUGGESTED_AGENTS: readonly {
	id: string;
	name: string;
	registryId: string | null;
}[] = [
	{ id: "acp:claude", name: "Claude Code", registryId: "claude-acp" },
	{ id: "acp:codex", name: "Codex", registryId: "codex-acp" },
	{ id: "acp:cursor", name: "Cursor", registryId: "cursor" },
	{ id: "acp:gemini", name: "Gemini CLI", registryId: "gemini" },
	{ id: "acp:opencode", name: "opencode", registryId: "opencode" },
	{
		id: "acp:copilot",
		name: "GitHub Copilot CLI",
		registryId: "github-copilot-cli",
	},
	{ id: "acp:grok", name: "Grok CLI", registryId: "grok-build" },
	{ id: "acp:droid", name: "Factory Droid", registryId: "factory-droid" },
	{ id: "acp:qwen", name: "Qwen Code", registryId: "qwen-code" },
	{ id: "acp:goose", name: "Goose", registryId: "goose" },
	{ id: "acp:cline", name: "Cline", registryId: "cline" },
	{ id: "hermes", name: "Hermes", registryId: null },
	{ id: "openclaw", name: "OpenClaw", registryId: null },
	{ id: "acp:prime", name: "Prime Agent", registryId: null },
	{ id: "acp:openhands", name: "OpenHands", registryId: null },
	{ id: "acp:blackbox", name: "Blackbox CLI", registryId: null },
	{ id: "acp:code-assistant", name: "Code Assistant", registryId: null },
	{ id: "acp:construct", name: "Construct", registryId: null },
	{ id: "acp:bub", name: "Bub", registryId: null },
	{ id: "acp:raxol", name: "Raxol", registryId: null },
	{ id: "acp:localharness", name: "localharness", registryId: null },
	{ id: "acp:kaagum", name: "Kaagum", registryId: null },
	{ id: "acp:docker-agent", name: "Docker Agent", registryId: null },
	{ id: "acp:agentpool", name: "AgentPool", registryId: null },
];

/**
 * The curated rows rendered when the catalog could not be reached — the same
 * agents, minus the live `detected`/`added` flags Core would have filled in.
 * The logo resolver keys off `id`/`engine`/`registryId`, all of which are known
 * statically, so these rows look identical to the live ones.
 */
export function fallbackSuggestedAgents(): AgentCatalogEntry[] {
	return SUGGESTED_AGENTS.map(staticSuggestedAgent);
}

/** One curated agent as a catalog row, with the live flags Core would have filled
 *  in left blank. Split out of {@link fallbackSuggestedAgents} because the merge in
 *  {@link loadOnboardingAgents} needs a single row, not the whole list. */
export function staticSuggestedAgent(a: {
	id: string;
	name: string;
	registryId: string | null;
}): AgentCatalogEntry {
	return {
		added: false,
		available: true,
		bridgeVersionStatus: null,
		description: null,
		detected: null,
		engine: null,
		gatewayBypass: false,
		iconUrl: null,
		id: a.id,
		installedBridgeVersion: null,
		installedVersion: null,
		installHint: null,
		latestBridgeVersion: null,
		latestVersion: null,
		name: a.name,
		recommended: false,
		registryId: a.registryId,
		transport: null,
		versionStatus: null,
	};
}

export interface OnboardingAgents {
	/** Agents detected on the user's PATH — shown first, pre-selected. */
	found: AgentCatalogEntry[];
	/**
	 * False when the catalog call FAILED (401, timeout, node down) rather than
	 * genuinely returning nothing. The distinction is the whole bug: the two were
	 * conflated, so an unreachable Core read as "no agents to offer" and the step
	 * was dropped from the flow with no error, no toast and no log.
	 */
	ok: boolean;
	/** Curated popular agents not already present — opt-in, not pre-selected. */
	suggested: AgentCatalogEntry[];
}

/**
 * Split the agent catalog into the two onboarding buckets: agents already found
 * on the system, and the curated "suggested" set the user can opt into. Ryu and
 * already-added agents are excluded from both.
 *
 * On failure this returns `ok: false` WITH the static curated set, so the step
 * still has something to render. Callers must never treat a failure as a reason
 * to skip the step — a network error must not delete a step from a wizard.
 */
export async function loadOnboardingAgents(
	target: ApiTarget
): Promise<OnboardingAgents> {
	try {
		// `versions: false` is what makes this step reliable rather than merely
		// bounded. The versioned catalog does an npm-registry lookup per agent
		// (~30s warm, unbounded cold), so the timeout below was routinely the thing
		// that decided whether the step appeared: one slow network and BOTH buckets
		// came back empty, the caller skipped straight to the next phase, and the
		// agent step looked deleted. Detection needs none of that work — it is a
		// PATH check — so onboarding asks for exactly the two flags it reads.
		const agents = await fetchAgentCatalog(
			target,
			AbortSignal.timeout(AGENT_CATALOG_TIMEOUT_MS),
			{ versions: false }
		);
		const installable = agents.filter((a) => a.id !== "ryu" && !a.added);
		const found = installable.filter((a) => a.detected === true);
		// Curation UNION catalog, not curation filtered BY it. The catalog's agent
		// list is fetched from the remote ACP registry and cached; when that fetch
		// fails or times out on a cold start Core says so and serves a partial list
		// (see `ensure_registry_cached`). Intersecting against it therefore deleted
		// well-known agents from the step for a reason that has nothing to do with
		// this machine — and on a system where nothing is detected, that left the
		// user staring at "Add your agents" with nothing to add.
		//
		// A live row always wins (it carries `detected`/`added`/description/icon);
		// a curated agent the catalog does not mention falls back to its static row
		// so the offer is at least present. Installing one of those may fail, which
		// is fine: `finish` adds agents with `allSettled` precisely because an add is
		// best-effort, and a row that fails to install beats a row that never appears.
		const suggested = SUGGESTED_AGENTS.map((curated) => {
			const live = installable.find((a) => a.id === curated.id);
			if (live) {
				return live.detected === true ? undefined : live;
			}
			// Absent from `installable` because it is already added, or because the
			// catalog never listed it. Only the second case earns a fallback row.
			return agents.some((a) => a.id === curated.id)
				? undefined
				: staticSuggestedAgent(curated);
		}).filter((a): a is AgentCatalogEntry => a !== undefined);
		return { found, ok: true, suggested };
	} catch (err) {
		// Never silent: this exact swallow is how a 401 turned into a missing step.
		track({
			event: "onboarding_agent_catalog_failed",
			reason: failReason(err),
		});
		return { found: [], ok: false, suggested: fallbackSuggestedAgents() };
	}
}

/** Why the catalog call failed, as one of the analytics enum's literals. */
export function failReason<TError>(
	err: TError
): "unauthorized" | "timeout" | "unreachable" {
	if (isUnauthorized(err)) {
		return "unauthorized";
	}
	if (
		err instanceof Error &&
		(err.name === "TimeoutError" || /timed? ?out/i.test(err.message))
	) {
		return "timeout";
	}
	return "unreachable";
}
