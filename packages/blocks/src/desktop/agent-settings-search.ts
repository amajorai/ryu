// Searchable index of the agent editor's own settings.
//
// The editor holds nine tabs and roughly sixty settings. Before this, finding
// one meant knowing which tab it was filed under — the same problem the two
// settings dialogs had before `settings-index.ts`, and solved the same way: a
// declared list of ROWS, not tabs, so "where do I turn off memory writing" has an
// answer for a tab you have never opened.
//
// WHY NOT REUSE `apps/desktop/src/lib/settings-index.ts`: it lives in the desktop
// app, this editor lives in `@ryu/blocks`, and its `SettingsDialogId` union is
// `"app" | "gateway"` — the editor is neither. Importing across that boundary
// would also break the storyboard, which renders this form without the desktop
// app around it. Same mechanism, own index.
//
// KEEPING IT HONEST: `agent-settings-search.test.ts` re-reads `agent-edit.tsx`
// and asserts every indexed label still appears there, so a renamed row surfaces
// as a failing test rather than as search that quietly finds nothing.

/** The editor tab that owns a setting. Matches the `editorTabs` ids. */
export type AgentSettingsTab =
	| "activity"
	| "advanced"
	| "behavior"
	| "connections"
	| "health"
	| "integrations"
	| "model"
	| "prompt-studio"
	| "tools"
	| "triggers";

export interface AgentSettingsEntry {
	/** The `SettingsSection` header above the row. Empty for ungrouped rows. */
	group: string;
	/** Stable id — React key and the `data-setting-id` anchor when one exists. */
	id: string;
	/** Extra search terms absent from the label. Space-separated. */
	keywords?: string;
	/** The row's visible title, verbatim. This is also the DOM anchor. */
	label: string;
	/** Which tab renders it. */
	tab: AgentSettingsTab;
}

/** Human labels for the tab ids, so a hit can say where it lives. */
export const AGENT_TAB_LABELS: Record<AgentSettingsTab, string> = {
	behavior: "Behavior",
	model: "Model",
	tools: "Tools & knowledge",
	connections: "Connections",
	integrations: "Integrations",
	health: "Health",
	triggers: "Triggers",
	activity: "Activity",
	"prompt-studio": "Prompt Studio",
	advanced: "Advanced",
};

export const AGENT_SETTINGS_ENTRIES: AgentSettingsEntry[] = [
	// ── Behavior ──────────────────────────────────────────────────────────────
	{
		id: "agent.instructions",
		label: "Instructions",
		group: "",
		tab: "behavior",
		keywords: "system prompt persona what it does role brief",
	},
	{
		id: "agent.rules",
		label: "Rules",
		group: "",
		tab: "behavior",
		keywords: "always never constraints guardrails do not",
	},
	{
		id: "agent.display-name",
		label: "Display name",
		group: "Personality & tone",
		tab: "behavior",
		keywords: "nickname how it introduces itself",
	},
	{
		id: "agent.tone",
		label: "Tone",
		group: "Personality & tone",
		tab: "behavior",
		keywords: "voice style formal friendly concise personality",
	},
	{
		id: "agent.personality-profile",
		label: "Personality profile",
		group: "Personality & tone",
		tab: "behavior",
		keywords: "output style preset plugin reusable voice profile",
	},
	{
		id: "agent.custom-tone",
		label: "Custom tone",
		group: "Personality & tone",
		tab: "behavior",
		keywords: "own words style description",
	},

	// ── Model ─────────────────────────────────────────────────────────────────
	{
		id: "agent.model-provider",
		label: "Model & provider",
		group: "",
		tab: "model",
		keywords: "engine llm openai anthropic local which ai",
	},
	{
		id: "agent.chat-model",
		label: "Chat model",
		group: "Model & provider",
		tab: "model",
		keywords: "default model conversation gpt claude",
	},
	{
		id: "agent.start-command",
		label: "Command to start your agent",
		group: "",
		tab: "model",
		keywords: "cli binary spawn argv acp external",
	},
	{
		id: "agent.gateway-routing",
		label: "Gateway routing",
		group: "",
		tab: "model",
		keywords: "proxy metering budget policy",
	},
	{
		id: "agent.route-through-gateway",
		label: "Route through Ryu Gateway",
		group: "Gateway routing",
		tab: "model",
		keywords: "proxy meter spend cost tracking",
	},

	// ── Tools & knowledge ─────────────────────────────────────────────────────
	{
		id: "agent.tools",
		label: "Tools",
		group: "",
		tab: "tools",
		keywords: "abilities capabilities mcp functions what it can use",
	},
	{
		id: "agent.skills",
		label: "Skills",
		group: "",
		tab: "tools",
		keywords: "playbooks procedures how-to",
	},
	{
		id: "agent.memory-spaces",
		label: "Memory & Spaces",
		group: "",
		tab: "tools",
		keywords: "remember recall knowledge base rag documents scope",
	},
	{
		id: "agent.memory-write",
		label: "Allow writing memories",
		group: "Memory & Spaces",
		tab: "tools",
		// "write" as well as the label's "writing": terms are matched as substrings
		// of the haystack, not stemmed, so "memory write" would otherwise miss the
		// one row it obviously means.
		keywords: "write remember save learn store facts",
	},

	// ── Connections ───────────────────────────────────────────────────────────
	{
		id: "agent.connections",
		label: "Connections",
		group: "",
		tab: "connections",
		keywords: "apps accounts integrations composio slack gmail",
	},
	{
		id: "agent.connect-with-code",
		label: "Call your agent from code",
		group: "",
		tab: "integrations",
		keywords: "api sdk snippet endpoint webhook reach it",
	},
	{
		id: "agent.github-actions",
		label: "GitHub Actions",
		group: "Other ways to use this agent",
		tab: "integrations",
		keywords: "ci cd pull request release automation workflow",
	},
	{
		id: "agent.ryu-app",
		label: "Build a Ryu App",
		group: "Other ways to use this agent",
		tab: "integrations",
		keywords: "widget chat ui app create-ryu-app",
	},
	{
		id: "agent.mcp-host",
		label: "MCP host",
		group: "Other ways to use this agent",
		tab: "integrations",
		keywords: "model context protocol tools claude codex",
	},

	// ── Triggers ──────────────────────────────────────────────────────────────
	{
		id: "agent.schedule",
		label: "Schedule",
		group: "",
		tab: "triggers",
		keywords: "cron recurring automatic timer when it runs",
	},
	{
		id: "agent.run-on-schedule",
		label: "Run on a schedule",
		group: "Schedule",
		tab: "triggers",
		keywords: "enable cron automatic recurring",
	},
	{
		id: "agent.frequency",
		label: "Frequency",
		group: "Schedule",
		tab: "triggers",
		keywords: "hourly daily weekly weekdays how often",
	},
	{
		id: "agent.cron",
		label: "Cron expression",
		group: "Schedule",
		tab: "triggers",
		keywords: "custom crontab five fields",
	},
	{
		id: "agent.event-triggers",
		label: "Event triggers",
		group: "",
		tab: "triggers",
		keywords: "webhook on event react fires when",
	},

	// ── Activity ──────────────────────────────────────────────────────────────
	{
		id: "agent.evals",
		label: "Run evals",
		group: "",
		tab: "activity",
		keywords: "quality tests score benchmark grading",
	},
	{
		id: "agent.history",
		label: "Run history",
		group: "",
		tab: "activity",
		keywords: "past runs log what it did transcript",
	},

	// ── Advanced ──────────────────────────────────────────────────────────────
	{
		id: "agent.advanced-slots",
		label: "Advanced",
		group: "",
		tab: "advanced",
		keywords:
			"slots speech to text tts image model gateway policy extra models",
	},
	{
		id: "agent.byoa",
		label: "Bring external agent",
		group: "",
		tab: "integrations",
		keywords: "byoa claude code codex opencode acp bridge own agent",
	},
];

export interface AgentSettingsHit extends AgentSettingsEntry {
	/** Lower is better. Exposed so a caller can show hits in relevance order. */
	score: number;
}

/**
 * Rank an entry against a query, or null if it does not match.
 *
 * Every whitespace-separated term must appear somewhere in the entry, so extra
 * words narrow rather than widen — "memory write" finds one row, not every row
 * about memory. Label matches beat group matches beat keyword matches, and a
 * label that STARTS with the query beats one that merely contains it, which is
 * what makes typing "to" surface "Tone" above "Route through Ryu Gateway".
 */
function scoreEntry(entry: AgentSettingsEntry, query: string): number | null {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) {
		return null;
	}
	const label = entry.label.toLowerCase();
	const group = entry.group.toLowerCase();
	const keywords = (entry.keywords ?? "").toLowerCase();
	const haystack = `${label} ${group} ${keywords}`;
	if (!terms.every((term) => haystack.includes(term))) {
		return null;
	}
	const joined = terms.join(" ");
	if (label.startsWith(joined)) {
		return 0;
	}
	if (label.includes(joined)) {
		return 1;
	}
	if (group.includes(joined)) {
		return 2;
	}
	return 3;
}

/** Matching settings, best first. */
export function searchAgentSettings(
	query: string,
	limit = 12
): AgentSettingsHit[] {
	const trimmed = query.trim();
	if (!trimmed) {
		return [];
	}
	const hits: AgentSettingsHit[] = [];
	for (const entry of AGENT_SETTINGS_ENTRIES) {
		const score = scoreEntry(entry, trimmed);
		if (score !== null) {
			hits.push({ ...entry, score });
		}
	}
	hits.sort((a, b) => a.score - b.score || a.label.localeCompare(b.label));
	return hits.slice(0, limit);
}

/** Normalized text of a node, for comparing against an indexed label. */
function textOf(el: Element): string {
	return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Find the DOM node for an entry inside `root`, or null.
 *
 * Same order as the desktop dialogs' reveal: an explicit `data-setting-id` wins,
 * a row title is the normal case, and the section header is the last resort so a
 * hit still lands in the right group when its row is behind a disclosure.
 */
export function findAgentSettingElement(
	entry: AgentSettingsEntry,
	root: ParentNode
): HTMLElement | null {
	const byId = root.querySelector<HTMLElement>(
		`[data-setting-id="${CSS.escape(entry.id)}"]`
	);
	if (byId) {
		return byId;
	}
	const label = entry.label.replace(/\s+/g, " ").trim();
	for (const title of root.querySelectorAll<HTMLElement>(
		'[data-slot="item-title"]'
	)) {
		if (textOf(title) === label) {
			return title.closest<HTMLElement>('[data-slot="item"]') ?? title;
		}
	}
	for (const heading of root.querySelectorAll<HTMLElement>("h3")) {
		if (
			textOf(heading) === label ||
			(entry.group && textOf(heading) === entry.group)
		) {
			return heading;
		}
	}
	return null;
}

/** How long to keep looking for a row that has not mounted yet. */
const REVEAL_TIMEOUT_MS = 2000;

/**
 * Poll for the entry's element until it exists or the deadline passes, then
 * scroll to and pulse it. Returns a cancel function.
 *
 * The poll exists because selecting a hit switches TABS first: the row is a
 * commit (or, for a panel that fetches, several hundred ms) away from being in
 * the DOM when the click handler runs.
 */
export function revealAgentSetting(
	entry: AgentSettingsEntry,
	root: ParentNode,
	now: () => number = () => performance.now()
): () => void {
	const deadline = now() + REVEAL_TIMEOUT_MS;
	let frame = 0;
	let cancelled = false;
	const tick = () => {
		if (cancelled) {
			return;
		}
		const el = findAgentSettingElement(entry, root);
		if (el) {
			el.scrollIntoView({ behavior: "smooth", block: "center" });
			// `currentColor`-derived ring so it reads in both themes, via the Web
			// Animations API so a CSS purge cannot drop it and an unmount mid-pulse
			// needs no cleanup.
			el.animate?.(
				[
					{
						boxShadow:
							"0 0 0 0 color-mix(in oklab, currentColor 45%, transparent)",
					},
					{
						boxShadow:
							"0 0 0 3px color-mix(in oklab, currentColor 45%, transparent)",
					},
					{
						boxShadow:
							"0 0 0 3px color-mix(in oklab, currentColor 45%, transparent)",
					},
					{
						boxShadow:
							"0 0 0 0 color-mix(in oklab, currentColor 0%, transparent)",
					},
				],
				{ duration: 1600, easing: "ease-out" }
			);
			return;
		}
		if (now() >= deadline) {
			return;
		}
		frame = requestAnimationFrame(tick);
	};
	frame = requestAnimationFrame(tick);
	return () => {
		cancelled = true;
		cancelAnimationFrame(frame);
	};
}
