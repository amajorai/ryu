// Two jobs:
//   1. Prove the search ranking does what the UI promises.
//   2. Stop the index rotting. Rows get renamed; nothing in the type system ties
//      an indexed label to the JSX that renders it, so this test re-reads the
//      settings sources and fails when an indexed label no longer exists there.
//
// The reverse direction (labels in source, missing from the index) is REPORTED,
// not failed: some rows are readouts, not settings, and forcing every one of them
// into the index would make the search list worse, not better.

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	SETTINGS_ENTRIES,
	SETTINGS_SECTION_LABELS,
	searchSettings,
	sectionLabel,
	subpageFor,
	visibleSettingsEntries,
} from "./settings-index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETTINGS_DIR = join(HERE, "..", "components", "settings");
const GATEWAY_DIALOG = join(
	HERE,
	"..",
	"components",
	"gateway",
	"GatewayDialog.tsx"
);
/**
 * The gateway dialog's source: `GatewayDialog.tsx` plus the section modules it
 * was split into under `gateway-dialog/`, read as one text.
 */
const readGatewayDialog = (): string => {
	const dir = join(dirname(GATEWAY_DIALOG), "gateway-dialog");
	const parts = readdirSync(dir)
		.filter((f) => /\.tsx?$/.test(f))
		.sort()
		.map((f) => readFileSync(join(dir, f), "utf8"));
	return [readWithSplits(GATEWAY_DIALOG), ...parts].join("\n");
};
const SETTINGS_DIALOG = join(
	HERE,
	"..",
	"components",
	"settings",
	// The static nav groups (value + label pairs) live beside the dialog.
	"settings-dialog-nav.tsx"
);

/**
 * Every file that can legitimately own a row for a given section. A section can
 * have several (Voice is five sub-panels; Gateway sections live either in their
 * own component file or inline in GatewayDialog.tsx).
 */
const SECTION_LABELS_BY_KEY = new Map(Object.entries(SETTINGS_SECTION_LABELS));

const SECTION_SOURCES = {
	// The Tabs settings, plus the pane-layout preset manager rendered beside
	// them from its own file (same pattern as Voice's sub-panels).
	general: [
		"GeneralTab.tsx",
		"AvailabilitySettings.tsx",
		"ResumeInterruptedChatsSetting.tsx",
		"SplitPresetSettings.tsx",
	],
	appearance: [
		"AppearanceTab.tsx",
		"appearance-theme-intro.tsx",
		"appearance-theme-panel.tsx",
		"appearance-layout-page.tsx",
		"appearance-interface-page.tsx",
		"appearance-chat-page.tsx",
		"appearance-diff-page.tsx",
		"appearance-files-page.tsx",
		"appearance-seasonal-effects.tsx",
		"appearance-level-sliders.tsx",
		"appearance-preset-fields.tsx",
		"InterfaceSettingsPanel.tsx",
		"WallpaperSetting.tsx",
		"../../lib/appearance-settings.ts",
		"../../lib/appearance-settings-theme.ts",
		"../../lib/appearance-settings-display.ts",
	],
	developer: ["DeveloperTab.tsx", "DevMetricsPanel.tsx"],
	account: ["AccountTab.tsx"],
	sessions: ["SessionsTab.tsx"],
	sync: ["SettingsSyncTab.tsx"],
	voice: [
		"AudioDevicesSettings.tsx",
		"VoiceModeDisplaySettings.tsx",
		"VoiceInputSettings.tsx",
		"VoiceReadbackSettings.tsx",
		"TtsEngineSettings.tsx",
	],
	privacy: [
		"PrivacySettings.tsx",
		"DevicePermissionsSettings.tsx",
		"CustomAppSecuritySettings.tsx",
	],
	storage: ["StorageSettings.tsx", "BackupSettings.tsx"],
	encryption: ["EncryptionSettings.tsx"],
	danger: ["DangerZoneSettings.tsx"],
	network: ["NetworkSettings.tsx", "DesktopRouteSettings.tsx"],
	integrations: ["IntegrationsTab.tsx"],
	connections: ["ConnectionsTab.tsx", "CloudSyncSection.tsx"],
	hooks: ["../gateway/HooksSection.tsx"],
	git: ["../gateway/GitSettingsSection.tsx"],
	worktrees: ["../gateway/WorktreesSection.tsx"],
	environments: ["../gateway/EnvironmentsSection.tsx"],
	"cloud-environments": ["../gateway/CloudEnvironmentsSettings.tsx"],
	runtime: ["../gateway/AcpRuntimeSection.tsx"],
};
const SECTION_SOURCES_BY_KEY = new Map(Object.entries(SECTION_SOURCES));

/**
 * Entries whose label is deliberately NOT a verbatim row title — the
 * group-level entries for bespoke panes, and the sections that render from a
 * registry rather than from `SettingsItem` rows (keyboard shortcuts, updates).
 * Listed explicitly so "not checked" is a decision on the page, not an accident.
 */
const UNANCHORED_SECTIONS = new Set([
	"keyboard",
	"updates",
	"keys",
	"guardrails",
	// Rendered by the shared policy workspace in @ryu/blocks.
	"policies",
	// Rendered by the shared gateway canvas in @ryu/blocks.
	"traffic-map",
	"providers",
	"defaults",
	"access",
	"permissions",
	"workspace",
	"usage",
	"email-alerts",
	"audit",
	"evals",
	"health",
	"routing",
	"budgets",
	"hooks",
	"git",
	"worktrees",
	"environments",
]);

/**
 * A component file plus the `<Name>-*.ts(x)` siblings it was split into, so a
 * row that moved into a sibling still counts as rendered by that component.
 */
const readWithSplits = (path: string): string => {
	const directory = dirname(path);
	const stem = basename(path).replace(/\.tsx?$/, "");
	const siblings = readdirSync(directory)
		.filter(
			(name) =>
				name.startsWith(`${stem}-`) &&
				/\.tsx?$/.test(name) &&
				!name.includes(".test.")
		)
		.sort();
	return [path, ...siblings.map((name) => join(directory, name))]
		.map((file) => readFileSync(file, "utf8"))
		.join("\n");
};

const escapeRegExp = (value: string): string =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("settings index navigation integrity", () => {
	it("uses the visible label for each destination section", () => {
		const sources = {
			app: readWithSplits(SETTINGS_DIALOG),
			gateway: readGatewayDialog(),
		};
		const stale: string[] = [];

		for (const entry of SETTINGS_ENTRIES) {
			const sectionLabel =
				SECTION_LABELS_BY_KEY.get(entry.section) ?? entry.section;
			const navItem = new RegExp(
				`\\{[^{}]*\\bvalue:\\s*"${escapeRegExp(entry.section)}"[^{}]*\\blabel:\\s*"${escapeRegExp(sectionLabel)}"[^{}]*\\}`,
				"s"
			);
			if (!navItem.test(sources[entry.dialog])) {
				stale.push(
					`${entry.id} → ${entry.dialog}/${entry.section}: ${sectionLabel}`
				);
			}
		}

		expect(stale).toEqual([]);
	});
});

const readSection = (section: string): string | null => {
	const files = SECTION_SOURCES_BY_KEY.get(section);
	if (!files) {
		return null;
	}
	return files.map((f) => readWithSplits(join(SETTINGS_DIR, f))).join("\n");
};

describe("settings index integrity", () => {
	it("has unique ids", () => {
		const ids = SETTINGS_ENTRIES.map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("names a section label for every entry", () => {
		for (const entry of SETTINGS_ENTRIES) {
			// Falls back to the raw value when unmapped — that fallback is the bug
			// this asserts against, not a feature.
			expect(sectionLabel(entry)).not.toBe(entry.section);
		}
	});

	it("every indexed label still exists in the source that renders it", () => {
		const stale: string[] = [];
		for (const entry of SETTINGS_ENTRIES) {
			if (UNANCHORED_SECTIONS.has(entry.section)) {
				continue;
			}
			const source = readSection(entry.section) ?? readGatewayDialog();
			if (!source.includes(`"${entry.label}"`)) {
				stale.push(`${entry.id} → "${entry.label}"`);
			}
		}
		expect(stale).toEqual([]);
	});
});

describe("searchSettings", () => {
	it.each(
		SETTINGS_ENTRIES.map((entry) => [entry.id, entry] as const)
	)("finds %s by its displayed label and applies the correct host scope", (_id, entry) => {
		// Exercise the user query, including case and whitespace normalization,
		// for every current setting rather than checking a source declaration.
		const query = `  ${entry.label.toUpperCase().replace(/\s+/g, "   ")}  `;
		const results = searchSettings(query);
		expect(results.map((result) => result.id)).toContain(entry.id);
		expect(
			visibleSettingsEntries(results, true).map((result) => result.id)
		).toContain(entry.id);
		const browserIds = visibleSettingsEntries(results, false).map(
			(result) => result.id
		);
		if (entry.desktopOnly) {
			expect(browserIds).not.toContain(entry.id);
		} else {
			expect(browserIds).toContain(entry.id);
		}
	});
	it("hides the Interfaces entries when no workspace interface can be opened", () => {
		const interfaceEntries = SETTINGS_ENTRIES.filter((entry) =>
			entry.id.startsWith("appearance.interfaces.")
		);
		expect(interfaceEntries).toHaveLength(3);
		const results = interfaceEntries.flatMap((entry) =>
			searchSettings(entry.label)
		);
		for (const entry of interfaceEntries) {
			expect(entry.requiresWorkspace).toBe(true);
			expect(
				visibleSettingsEntries(results, true, true).map((result) => result.id)
			).toContain(entry.id);
			expect(
				visibleSettingsEntries(results, true, false).map((result) => result.id)
			).not.toContain(entry.id);
		}
	});
	it("returns nothing for an empty query", () => {
		expect(searchSettings("")).toEqual([]);
		expect(searchSettings("   ")).toEqual([]);
	});

	it("ranks an exact label above a partial one", () => {
		const results = searchSettings("density");
		expect(results[0]?.label).toBe("Density");
	});

	it("finds a setting by a word that is not in its label", () => {
		// "dark mode" is what people type; the row is called "Color theme".
		const ids = searchSettings("dark mode").map((e) => e.id);
		expect(ids).toContain("appearance.theme.color-theme");
	});

	it("finds the send shortcut setting from its visible title", () => {
		const ids = searchSettings("send shortcut").map((entry) => entry.id);
		expect(ids).toContain("general.chats.send-shortcut");
	});

	it("ANDs the tokens instead of ORing them", () => {
		const both = searchSettings("diff line");
		expect(both.length).toBeGreaterThan(0);
		for (const entry of both) {
			const hay =
				`${entry.label} ${entry.group} ${entry.keywords ?? ""}`.toLowerCase();
			expect(hay).toContain("line");
		}
		// A token that matches nothing kills the whole query.
		expect(searchSettings("diff zzzznotathing")).toEqual([]);
	});

	it("reaches into both dialogs from one query", () => {
		const dialogs = new Set(searchSettings("key").map((e) => e.dialog));
		expect(dialogs.has("gateway")).toBe(true);
	});

	it("respects the result cap", () => {
		expect(searchSettings("e", 5).length).toBeLessThanOrEqual(5);
	});

	it("removes desktop-only results from browser surfaces", () => {
		const desktopResults = visibleSettingsEntries(
			searchSettings("start ryu startup"),
			true
		);
		const browserResults = visibleSettingsEntries(
			searchSettings("start ryu startup"),
			false
		);

		expect(desktopResults.map((entry) => entry.id)).toContain(
			"general.system.start-ryu-on-startup"
		);
		expect(browserResults).toEqual([]);
	});

	it("keeps the send shortcut setting out of browser surfaces", () => {
		const desktopResults = visibleSettingsEntries(
			searchSettings("send shortcut"),
			true
		);
		const browserResults = visibleSettingsEntries(
			searchSettings("send shortcut"),
			false
		);

		expect(desktopResults.map((entry) => entry.id)).toContain(
			"general.chats.send-shortcut"
		);
		expect(browserResults.map((entry) => entry.id)).not.toContain(
			"general.chats.send-shortcut"
		);
	});

	it("keeps native transparency settings desktop-only", () => {
		const desktopResults = visibleSettingsEntries(
			searchSettings("transparent window"),
			true
		);
		const browserResults = visibleSettingsEntries(
			searchSettings("transparent window"),
			false
		);

		expect(desktopResults.map((entry) => entry.id)).toContain(
			"appearance.interface.transparent-window"
		);
		expect(browserResults).toEqual([]);
	});
});

describe("settings subpage ownership", () => {
	it("uses the known grouping and keeps explicit subpages authoritative", () => {
		expect(
			subpageFor({
				dialog: "app",
				group: "Motion",
				id: "motion",
				label: "Motion",
				section: "appearance",
			})
		).toBe("motion");
		expect(
			subpageFor({
				dialog: "app",
				group: "constructor",
				id: "custom",
				label: "Custom",
				section: "constructor",
				subpage: "owned-page",
			})
		).toBe("owned-page");
	});

	it("keeps missing and inherited-name groups on the section index", () => {
		for (const section of [
			"appearance",
			"general",
			"missing",
			"constructor",
			"__proto__",
		]) {
			for (const group of ["missing", "constructor", "toString", "__proto__"]) {
				expect(
					subpageFor({
						dialog: "app",
						group,
						id: "custom",
						label: "Custom",
						section,
					})
				).toBeNull();
			}
		}
	});
});

describe("OTLP diagnostics export entries", () => {
	const CONTENT_MODE = "gw.privacy.diagnostics-export.content-mode";
	const TEST_DESTINATION = "gw.privacy.diagnostics-export.test-destination";
	const entryFor = (id: string) => {
		const found = SETTINGS_ENTRIES.find((entry) => entry.id === id);
		if (!found) {
			throw new Error(`Missing indexed entry ${id}`);
		}
		return found;
	};

	it("indexes the content mode and the test destination on the Diagnostics & support page, in the browser too", () => {
		for (const id of [CONTENT_MODE, TEST_DESTINATION]) {
			const entry = entryFor(id);
			expect({
				dialog: entry.dialog,
				group: entry.group,
				section: entry.section,
				subpage: subpageFor(entry),
				desktopOnly: entry.desktopOnly ?? false,
			}).toEqual({
				dialog: "gateway",
				group: "Diagnostics export",
				section: "privacy",
				subpage: "diagnostics",
				desktopOnly: false,
			});
		}
		expect(entryFor(CONTENT_MODE).label).toBe("Content mode");
		expect(entryFor(TEST_DESTINATION).label).toBe("Test destination");
	});

	it("finds the content mode by what people type for it", () => {
		for (const query of [
			"content mode",
			"full content",
			"prompts responses",
			"opentelemetry",
		]) {
			expect(searchSettings(query).map((entry) => entry.id)).toContain(
				CONTENT_MODE
			);
		}
	});

	it("finds the test destination by what people type for it", () => {
		for (const query of [
			"test destination",
			"test span",
			"verify endpoint",
			"collector",
		]) {
			expect(searchSettings(query).map((entry) => entry.id)).toContain(
				TEST_DESTINATION
			);
		}
	});

	it("keeps the two rows out of unrelated queries", () => {
		const ids = searchSettings("send shortcut").map((entry) => entry.id);
		expect(ids).not.toContain(CONTENT_MODE);
		expect(ids).not.toContain(TEST_DESTINATION);
	});
});
