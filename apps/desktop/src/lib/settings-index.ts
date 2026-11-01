// A searchable index of individual settings — the rows, not the tabs.
//
// The search box in either settings dialog used to filter the NAV: you typed
// "dark" and it told you which of nineteen tabs was called something like that.
// That is useless for the actual question ("where is the thing that turns the
// theme dark"), because the answer is a ROW inside a tab, and rows were not
// indexed anywhere.
//
// This module is that index. Each entry names one setting: its visible label,
// the group header above it, the dialog + section that renders it, and optional
// `keywords` carrying the words a user would plausibly type but that do not
// appear in the label ("dark mode" for "Theme mode", "hotkey" for a shortcut).
//
// WHY A DECLARED LIST AND NOT RUNTIME DISCOVERY: walking the rendered DOM would
// only ever see the section that happens to be mounted, so search would silently
// miss every setting the user is not already looking at. A declared list is the
// only form that can answer "where is X" for an X you have never opened.
//
// KEEPING IT HONEST: `settings-index.test.ts` re-reads the settings source files
// and asserts every indexed label still exists in the file that owns its
// section. Rename a row and the test names the stale entry. It also reports —
// but does not fail on — labels present in source and missing here, because some
// rows are readouts (a metric, a status line) and are deliberately not indexed.
//
// COVERAGE (stated plainly rather than implied):
//   - ROW-LEVEL: General, Appearance, Developer, Account, Voice, Sounds (App dialog);
//     Privacy, Storage, Encryption, Danger zone, Network, Integrations,
//     Connections, Routing, Budgets, Updates (Gateway dialog).
//   - GROUP-LEVEL only: Keys, Guardrails, Providers, Workspace, Defaults, Usage,
//     Audit, Evals, Permissions, Access, Email alerts — these render bespoke
//     cards (key vaults, provider grids, permission matrices) whose "rows" are
//     data, not settings. They are indexed by their group name so a search still
//     lands you on the right pane.
//   - NOT INDEXED: per-app / per-plugin settings tabs (`app:<id>` /
//     `plugin:<id>`). Those are contributed at runtime by manifests, so they
//     cannot be in a static list; both dialogs already match them by label.

import { APP_APPEARANCE_SETTINGS_ENTRIES } from "./settings-index/app-appearance.ts";
import { APP_APPEARANCE_MORE_SETTINGS_ENTRIES } from "./settings-index/app-appearance-more.ts";
import { APP_GENERAL_SETTINGS_ENTRIES } from "./settings-index/app-general.ts";
import { APP_OTHER_SETTINGS_ENTRIES } from "./settings-index/app-other.ts";
import { APP_SOUNDS_SETTINGS_ENTRIES } from "./settings-index/app-sounds.ts";
import { GATEWAY_SETTINGS_ENTRIES } from "./settings-index/gateway.ts";
import { GATEWAY_MORE_SETTINGS_ENTRIES } from "./settings-index/gateway-more.ts";

/** Which of the two settings dialogs owns a setting. */
export type SettingsDialogId = "app" | "gateway";

export interface SettingsEntry {
	/** Hidden outside the native desktop shell. */
	desktopOnly?: boolean;
	/** Which dialog renders it — decides where a result click navigates. */
	dialog: SettingsDialogId;
	/** The `SettingsSection` header above the row. Empty for ungrouped rows. */
	group: string;
	/** Stable id. Used for the focus handoff and as a React key. */
	id: string;
	/** Extra search terms not present in the label. Space-separated. */
	keywords?: string;
	/** The row's visible title, verbatim — this is also the DOM anchor. */
	label: string;
	/** Hidden when the user cannot open any workspace interface. */
	requiresWorkspace?: boolean;
	/** The dialog section value (`general`, `appearance`, `routing`, …). */
	section: string;
	/**
	 * The sub-page inside that section, for a pane that drills in
	 * ({@link SettingsSubpages}) instead of scrolling. Load-bearing for search: a
	 * row inside a closed sub-page is not in the DOM, and the reveal gives up
	 * after five seconds of polling — so without this a hit would land on the
	 * section and highlight nothing.
	 *
	 * Most entries leave it unset and let {@link subpageFor} derive it from the
	 * group, which is the same partition the pane itself uses.
	 */
	subpage?: string;
}

/**
 * Section → group → sub-page id, for the panes that drill in rather than scroll.
 *
 * Each split follows that pane's `SettingsSection` groups exactly, so the
 * mapping is stated once here rather than stamped onto a hundred entries by
 * hand. A group missing from its section's map (Appearance's Theme, General's
 * "On startup") stays on the pane's own index page, which is where a pane's
 * headline settings belong.
 */
const SUBPAGE_BY_GROUP = new Map<string, Map<string, string>>([
	[
		"appearance",
		new Map<string, string>([
			["Language & vibe", "language"],
			["Layout & sizing", "layout"],
			["Typography", "layout"],
			["Motion", "motion"],
			["Seasonal effects", "motion"],
			["Interface", "interface"],
			["Chat view", "chat"],
			["Interfaces", "interfaces"],
			["Every interface", "interfaces"],
			["Usage meter", "usage"],
			["Diff viewer", "diff"],
			["File tree", "files"],
			["Reset", "reset"],
		]),
	],
	// Not 1:1 with the sections here: the three "what we collect" groups share
	// one page, because three rows asking the same question is a longer index,
	// not a clearer one.
	[
		"privacy",
		new Map<string, string>([
			["Device permissions", "device-permissions"],
			["Product analytics", "sharing"],
			["Community stats", "sharing"],
			["Profile activity", "sharing"],
			["Crash reports", "sharing"],
			["Diagnostics export", "diagnostics"],
			["Support access (local)", "diagnostics"],
			["Self-healing", "healing"],
			["Custom app security", "security"],
		]),
	],
	[
		"general",
		new Map<string, string>([
			["Tabs", "tabs"],
			["Pane layouts", "tabs"],
			["Interface", "tabs"],
			["Chats", "chats"],
			["Availability & prompts", "chats"],
			["Language", "language"],
			["Terminal", "terminal"],
			["Files", "files"],
			["System", "system"],
			["Setup", "setup"],
		]),
	],
]);

/**
 * Which sub-page holds this setting, or null when its section is a flat scroll.
 * An explicit `subpage` on the entry wins; otherwise it is derived from the
 * group.
 */
export function subpageFor(entry: SettingsEntry): string | null {
	if (entry.subpage) {
		return entry.subpage;
	}
	return SUBPAGE_BY_GROUP.get(entry.section)?.get(entry.group) ?? null;
}

/** Human labels for section values, so a result can say where it lives. */
export const SETTINGS_SECTION_LABELS = {
	// App dialog
	general: "General",
	appearance: "Appearance",
	keyboard: "Keyboard Shortcuts",
	updates: "Updates",
	voice: "Voice",
	sounds: "Sounds",
	developer: "Developer",
	sync: "Settings Sync",
	account: "Account",
	profile: "Profile",
	stats: "Stats",
	sessions: "Sessions & devices",
	"ryu-apps": "Ryu apps",
	"authorized-apps": "OAuth apps",
	billing: "Billing",
	referrals: "Referrals",
	teams: "Teams",
	credits: "Credits",
	// Gateway dialog
	overview: "Overview",
	workspace: "Team & workspace",
	defaults: "Default agent & model",
	providers: "AI providers",
	keys: "API keys",
	access: "Devices & access",
	permissions: "Permissions",
	budgets: "Spending limits",
	guardrails: "Safety filters",
	"traffic-map": "Traffic map",
	policies: "Guardrail policies",
	runtime: "Agent runtime",
	routing: "Model routing",
	integrations: "Integrations",
	network: "Network",
	connections: "Connections",
	hooks: "Hooks",
	git: "Git",
	worktrees: "Worktrees",
	environments: "Environments",
	"cloud-environments": "Cloud environments",
	"email-alerts": "Email & alerts",
	privacy: "Privacy",
	storage: "Storage",
	encryption: "Encryption",
	usage: "Usage & cost",
	audit: "Activity log",
	evals: "Quality tests",
	health: "Diagnostics",
	danger: "Danger zone",
};
const SETTINGS_SECTION_LABELS_BY_KEY = new Map(
	Object.entries(SETTINGS_SECTION_LABELS)
);

export const SETTINGS_ENTRIES: SettingsEntry[] = [
	...APP_GENERAL_SETTINGS_ENTRIES,
	...APP_APPEARANCE_SETTINGS_ENTRIES,
	...APP_APPEARANCE_MORE_SETTINGS_ENTRIES,
	...APP_OTHER_SETTINGS_ENTRIES,
	...APP_SOUNDS_SETTINGS_ENTRIES,
	...GATEWAY_SETTINGS_ENTRIES,
	...GATEWAY_MORE_SETTINGS_ENTRIES,
];

export interface SettingsSearchHit {
	entry: SettingsEntry;
	score: number;
}

const WORD = /\s+/;

/**
 * Score one entry against one lowercase token. 0 means "no match", and because
 * matching is AND-across-tokens, a single 0 drops the entry entirely.
 *
 * The weights encode the ranking people expect: a label you typed exactly beats
 * a label that merely contains it, which beats a group header, which beats a
 * keyword you never saw on screen.
 */
function scoreToken(entry: SettingsEntry, token: string): number {
	const label = entry.label.toLowerCase();
	if (label === token) {
		return 120;
	}
	if (label.startsWith(token)) {
		return 80;
	}
	// Word-start inside the label ("mode" in "Theme mode") ranks above a match
	// that lands mid-word ("ode" in "mode"), which is usually a typo artifact.
	if (label.includes(` ${token}`)) {
		return 60;
	}
	if (label.includes(token)) {
		return 40;
	}
	const keywords = entry.keywords?.toLowerCase() ?? "";
	if (keywords.includes(token)) {
		return 30;
	}
	const group = entry.group.toLowerCase();
	if (group.includes(token)) {
		return 22;
	}
	const section = (
		SETTINGS_SECTION_LABELS_BY_KEY.get(entry.section) ?? entry.section
	).toLowerCase();
	if (section.includes(token)) {
		return 12;
	}
	return 0;
}

/**
 * Rank the index against a free-text query. Tokens are ANDed: "dark diff" must
 * match both words somewhere on the same entry, which is what makes a two-word
 * query narrow rather than widen the list.
 *
 * Returns entries, best first, capped at `limit`. An empty query returns [] —
 * "show me everything" is the nav's job, not search's.
 */
export function searchSettings(query: string, limit = 40): SettingsEntry[] {
	const tokens = query
		.trim()
		.toLowerCase()
		.split(WORD)
		.filter((t) => t.length > 0);
	if (tokens.length === 0) {
		return [];
	}
	const hits: SettingsSearchHit[] = [];
	for (const entry of SETTINGS_ENTRIES) {
		let total = 0;
		let matchedAll = true;
		for (const token of tokens) {
			const score = scoreToken(entry, token);
			if (score === 0) {
				matchedAll = false;
				break;
			}
			total += score;
		}
		if (matchedAll) {
			hits.push({ entry, score: total });
		}
	}
	hits.sort((a, b) =>
		b.score === a.score
			? a.entry.label.localeCompare(b.entry.label)
			: b.score - a.score
	);
	return hits.slice(0, limit).map((h) => h.entry);
}

export function visibleSettingsEntries(
	entries: readonly SettingsEntry[],
	isDesktop: boolean,
	workspace = true
): SettingsEntry[] {
	return entries.filter(
		(entry) =>
			(isDesktop || !entry.desktopOnly) &&
			(workspace || !entry.requiresWorkspace)
	);
}

/** The section label a result should print as its "where it lives" line. */
export function sectionLabel(entry: SettingsEntry): string {
	return SETTINGS_SECTION_LABELS_BY_KEY.get(entry.section) ?? entry.section;
}
