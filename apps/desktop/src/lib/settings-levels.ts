// The scope model of the desktop settings: which level each setting belongs to.
//
// The user sees three levels - App (this desktop app on this machine), Computer
// (the Ryu Core and Gateway a person connects to, local or remote) and Bot (one
// agent). Account and Org are the signed-in person and their organization, kept
// apart in code because their values live in the cloud, not in a Computer.
//
// THE RULE: a setting's level is decided by where its value is stored and what
// it affects, never by the dialog it sits in today.
//   - app - local app storage (localStorage, the Tauri shell, the OS).
//   - account - the account API of the signed-in person.
//   - org - billing and membership of an organization.
//   - computer - the Core or Gateway API of the active Computer.
//   - bot - the settings of one agent.
// So a row in the App Settings dialog that writes to Core (Prevent sleep while
// running) is a computer setting, and a row in the Gateway dialog that asks the
// OS for a permission (Microphone) is an app setting.
//
// This file also holds the canonical table of section ids for both dialogs.
// Each table is a Record over the dialog's section type, so adding a section
// without a level is a type error.

import type { GatewaySection } from "@/src/store/useGatewayDialog.ts";
import type { SettingsSectionValue } from "@/src/store/useSettingsDialog.ts";

/** The level a setting belongs to. See the rule at the top of this file. */
export type SettingsLevel = "app" | "account" | "org" | "computer" | "bot";

/** Every level, in the order a person meets them. */
export const SETTINGS_LEVELS: readonly SettingsLevel[] = [
	"app",
	"account",
	"org",
	"computer",
	"bot",
];

/**
 * App Settings dialog sections and the level most of their settings have.
 * A row whose storage differs carries its own level in the search index.
 */
export const APP_SECTION_LEVELS: Record<SettingsSectionValue, SettingsLevel> = {
	general: "app",
	appearance: "app",
	sounds: "app",
	keyboard: "app",
	voice: "app",
	account: "account",
	profile: "account",
	stats: "account",
	sessions: "account",
	"ryu-apps": "account",
	"authorized-apps": "account",
	referrals: "account",
	billing: "org",
	teams: "org",
	credits: "org",
	usage: "org",
	updates: "app",
	developer: "app",
	sync: "app",
};

/**
 * Gateway dialog sections. Every one of them reads and writes the Core or
 * Gateway API of the active Computer, including the group titled "This device".
 */
export const GATEWAY_SECTION_LEVELS: Record<GatewaySection, SettingsLevel> = {
	overview: "computer",
	workspace: "computer",
	permissions: "computer",
	defaults: "computer",
	providers: "computer",
	keys: "computer",
	routing: "computer",
	budgets: "computer",
	guardrails: "computer",
	"traffic-map": "computer",
	policies: "computer",
	runtime: "computer",
	hooks: "computer",
	api: "computer",
	network: "computer",
	integrations: "computer",
	connections: "computer",
	"email-alerts": "computer",
	git: "computer",
	worktrees: "computer",
	environments: "computer",
	"cloud-environments": "computer",
	mcp: "computer",
	import: "computer",
	export: "computer",
	usage: "computer",
	audit: "computer",
	evals: "computer",
	computer: "computer",
	onboarding: "computer",
	privacy: "computer",
	storage: "computer",
	encryption: "computer",
	access: "computer",
	updates: "computer",
	health: "computer",
	danger: "computer",
};

/**
 * App Settings section ids that were removed because nothing rendered them
 * (a deep link to one opened an empty pane). Kept only so a test can prove no
 * source still opens them.
 */
export const REMOVED_APP_SECTION_IDS: readonly string[] = [
	"integrations",
	"goals",
	"double-check",
];

/**
 * Old Gateway section ids that still open, mapped to the canonical section
 * that renders them. `access` was the deep link of the Connections hub before
 * it moved into Connections.
 */
export const GATEWAY_SECTION_ALIASES: Readonly<Record<string, GatewaySection>> =
	{
		access: "connections",
	};

/** The canonical Gateway section for a requested id (an alias resolves). */
export function canonicalGatewaySection(section: string): string {
	return Object.hasOwn(GATEWAY_SECTION_ALIASES, section)
		? (GATEWAY_SECTION_ALIASES[section] ?? section)
		: section;
}

/** Which settings dialog a section id belongs to. */
export type SettingsDialogKind = "app" | "gateway";

/**
 * The canonical id of a section - `<dialog>:<section>`. Plain section ids are
 * unique only inside one dialog (both have `updates` and `usage`).
 */
export function canonicalSectionId(
	dialog: SettingsDialogKind,
	section: string
): string {
	return `${dialog}:${section}`;
}

/** Every canonical section id of both dialogs. Aliases are not canonical. */
export function listCanonicalSectionIds(): string[] {
	return [
		...Object.keys(APP_SECTION_LEVELS).map((s) => canonicalSectionId("app", s)),
		...Object.keys(GATEWAY_SECTION_LEVELS)
			.filter((s) => !Object.hasOwn(GATEWAY_SECTION_ALIASES, s))
			.map((s) => canonicalSectionId("gateway", s)),
	];
}

/**
 * The level of a section, or null for an id the dialog does not have (a dynamic
 * `app:<id>` or `plugin:<id>` tab, or a removed id).
 */
export function sectionLevel(
	dialog: SettingsDialogKind,
	section: string
): SettingsLevel | null {
	const table: Record<string, SettingsLevel> =
		dialog === "app" ? APP_SECTION_LEVELS : GATEWAY_SECTION_LEVELS;
	return Object.hasOwn(table, section) ? (table[section] ?? null) : null;
}
