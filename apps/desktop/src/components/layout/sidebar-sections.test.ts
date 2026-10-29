import { describe, expect, it } from "bun:test";
import {
	Chat01Icon,
	FingerPrintIcon,
	LayerIcon,
	Package01Icon,
	PlugSocketIcon,
	PotionIcon,
	Tv01Icon,
} from "@hugeicons/core-free-icons";
import {
	BUILTIN_SECTIONS,
	DEFAULT_SECTION_ORDER,
	isSectionKey,
	LEGACY_APP_SECTION_KEYS,
	migrateLegacySectionKey,
	migrateLegacySectionRecord,
	migrateLegacySectionStorage,
	reconcileSectionOrder,
	SECTION_ICONS,
	SECTION_LABELS,
	type SectionKey,
} from "./sidebar-sections.ts";

// The order reconciliation is the load-bearing bit: it runs against whatever a
// user persisted on an older build, and losing their layout is a silent, per-user
// regression nobody reports. These cover the three ways a stored order drifts —
// it IS an old default (migrate), it is customised (preserve), or it names a
// section this build has never heard of (an app's, or a retired built-in).

function isMigratedAppDefault(order: SectionKey[]): boolean {
	return (
		JSON.stringify(order.filter((key) => !key.startsWith("plugin:@ryu/"))) ===
			JSON.stringify(DEFAULT_SECTION_ORDER) &&
		order.indexOf(LEGACY_APP_SECTION_KEYS.teams) ===
			order.indexOf("companions") + 1 &&
		order.indexOf(LEGACY_APP_SECTION_KEYS.workflows) ===
			order.indexOf("identities") + 1
	);
}

describe("section vocabulary", () => {
	it("derives label + icon for every section in the default order", () => {
		expect(DEFAULT_SECTION_ORDER).toHaveLength(BUILTIN_SECTIONS.length);
		for (const key of DEFAULT_SECTION_ORDER) {
			expect(SECTION_LABELS[key]).toBeTruthy();
			expect(SECTION_ICONS[key]).toBeTruthy();
		}
	});

	it("accepts built-in and app-registered keys, rejects anything else", () => {
		expect(isSectionKey("chats")).toBe(true);
		expect(isSectionKey("plugin:@ryu/meetings:meetings")).toBe(true);
		expect(isSectionKey("definitely-not-a-section")).toBe(false);
	});

	it("keeps the requested glyph vocabulary in one shared map", () => {
		expect(SECTION_ICONS.companions).toBe(Package01Icon);
		expect(SECTION_ICONS.plugins).toBe(PlugSocketIcon);
		expect(SECTION_ICONS.skills).toBe(PotionIcon);
		expect(SECTION_ICONS.chats).toBe(Chat01Icon);
		expect(SECTION_ICONS.channels).toBe(Tv01Icon);
		expect(SECTION_ICONS.identities).toBe(FingerPrintIcon);
		expect(SECTION_ICONS.engines).toBe(LayerIcon);
	});

	it("keeps app-owned Teams and Workflows out of the compiled vocabulary", () => {
		expect(DEFAULT_SECTION_ORDER).not.toContain("teams");
		expect(DEFAULT_SECTION_ORDER).not.toContain("workflows");
		expect(isSectionKey(LEGACY_APP_SECTION_KEYS.teams)).toBe(true);
		expect(isSectionKey(LEGACY_APP_SECTION_KEYS.workflows)).toBe(true);
	});
});

describe("reconcileSectionOrder", () => {
	it("migrates a stored order that is exactly a legacy default", () => {
		// Verbatim copy of the first legacy snapshot (pinned still at the bottom,
		// no `companions`) — a user who never customised anything on that build.
		const legacy = [
			"tabs",
			"agents",
			"teams",
			"projects",
			"chats",
			"spaces",
			"channels",
			"integrations",
			"plugins",
			"identities",
			"workflows",
			"skills",
			"mcp",
			"tools",
			"engines",
			"pinned",
			"archived",
		];
		expect(isMigratedAppDefault(reconcileSectionOrder(legacy))).toBe(true);
	});

	it("migrates the pre-bottom-apps default (plugins/apps still in the middle)", () => {
		// The default persisted before `plugins`/`companions` moved to the bottom —
		// a user who never customised anything on that build.
		const legacy = [
			"tabs",
			"agents",
			"teams",
			"projects",
			"pinned",
			"chats",
			"spaces",
			"channels",
			"integrations",
			"plugins",
			"companions",
			"identities",
			"workflows",
			"skills",
			"mcp",
			"tools",
			"engines",
			"archived",
		];
		expect(isMigratedAppDefault(reconcileSectionOrder(legacy))).toBe(true);
	});

	it("migrates the pre-apps-under-agents default (Apps still at the bottom)", () => {
		// The default persisted before `companions` (Apps) moved up beneath `agents`,
		// leaving `plugins` alone at the bottom — a user who never customised
		// anything on that build. Without this snapshot every existing install reads
		// as "customised" and keeps Apps at the bottom forever.
		const legacy = [
			"tabs",
			"agents",
			"teams",
			"projects",
			"pinned",
			"chats",
			"spaces",
			"channels",
			"integrations",
			"identities",
			"workflows",
			"skills",
			"mcp",
			"tools",
			"engines",
			"archived",
			"plugins",
			"companions",
		];
		expect(isMigratedAppDefault(reconcileSectionOrder(legacy))).toBe(true);
	});

	it("puts Apps directly below Agents in the default order", () => {
		expect(DEFAULT_SECTION_ORDER.indexOf("companions")).toBe(
			DEFAULT_SECTION_ORDER.indexOf("agents") + 1
		);
	});

	it("preserves a customised order verbatim", () => {
		// Archived dragged to the top — nothing missing, nothing unknown.
		const customised: SectionKey[] = [
			"archived",
			...DEFAULT_SECTION_ORDER.filter((k) => k !== "archived"),
		];
		expect(reconcileSectionOrder(customised)).toEqual(customised);
	});

	it("splices a never-seen built-in beside its default neighbour", () => {
		// A layout persisted before `companions` existed, but customised (pinned was
		// already promoted), so it must NOT take the legacy-migration path.
		const stored = DEFAULT_SECTION_ORDER.filter((k) => k !== "companions");
		const result = reconcileSectionOrder(stored);
		expect(result).toEqual(DEFAULT_SECTION_ORDER);
		// Specifically: right after its default predecessor, not appended at the end.
		expect(result.indexOf("companions")).toBe(result.indexOf("agents") + 1);
	});

	it("keeps an app-registered section in its stored position", () => {
		const appKey = "plugin:@ryu/meetings:meetings";
		const stored = ["tabs", appKey, ...DEFAULT_SECTION_ORDER.slice(1)];
		const result = reconcileSectionOrder(stored);
		expect(result[1]).toBe(appKey);
		// The app's section survives even though the shell has no built-in entry for
		// it — that is the whole point of the `plugin:` seam.
		expect(result).toHaveLength(DEFAULT_SECTION_ORDER.length + 1);
	});

	it("drops unknown keys and de-duplicates", () => {
		const stored = [
			"tabs",
			"retired-section",
			"tabs",
			...DEFAULT_SECTION_ORDER.slice(1),
		];
		const result = reconcileSectionOrder(stored);
		expect(result).toEqual(DEFAULT_SECTION_ORDER);
	});
});

describe("legacy app-section preferences", () => {
	it("migrates only owned legacy names and preserves inherited or unknown names", () => {
		expect(migrateLegacySectionKey("teams")).toBe(
			LEGACY_APP_SECTION_KEYS.teams
		);
		expect(migrateLegacySectionKey("workflows")).toBe(
			LEGACY_APP_SECTION_KEYS.workflows
		);
		for (const key of [
			"constructor",
			"toString",
			"__proto__",
			"hasOwnProperty",
			"",
			"unknown",
			"plugin:@ryu/meetings:meetings",
		]) {
			expect(migrateLegacySectionKey(key)).toBe(key);
		}
	});

	it("moves record preferences to dynamic keys and preserves newer values", () => {
		expect(
			migrateLegacySectionRecord({
				teams: 10,
				[LEGACY_APP_SECTION_KEYS.teams]: 25,
				workflows: 50,
			})
		).toEqual({
			[LEGACY_APP_SECTION_KEYS.teams]: 25,
			[LEGACY_APP_SECTION_KEYS.workflows]: 50,
		});
	});

	it("rewrites order, hidden, collapsed, page-size, and sort storage", () => {
		const values = new Map<string, string>([
			["order", JSON.stringify(["tabs", "teams", "workflows"])],
			["hidden", JSON.stringify(["teams"])],
			["collapsed", JSON.stringify(["workflows"])],
			["sizes", JSON.stringify({ teams: 25 })],
			["sorts", JSON.stringify({ workflows: "name-asc" })],
		]);
		migrateLegacySectionStorage(
			{
				getItem: (key) => values.get(key) ?? null,
				setItem: (key, value) => values.set(key, value),
			},
			{
				arrays: ["order", "hidden", "collapsed"],
				records: ["sizes", "sorts"],
			}
		);

		expect(JSON.parse(values.get("order") ?? "[]")).toEqual([
			"tabs",
			LEGACY_APP_SECTION_KEYS.teams,
			LEGACY_APP_SECTION_KEYS.workflows,
		]);
		expect(JSON.parse(values.get("hidden") ?? "[]")).toEqual([
			LEGACY_APP_SECTION_KEYS.teams,
		]);
		expect(JSON.parse(values.get("collapsed") ?? "[]")).toEqual([
			LEGACY_APP_SECTION_KEYS.workflows,
		]);
		expect(JSON.parse(values.get("sizes") ?? "{}")).toEqual({
			[LEGACY_APP_SECTION_KEYS.teams]: 25,
		});
		expect(JSON.parse(values.get("sorts") ?? "{}")).toEqual({
			[LEGACY_APP_SECTION_KEYS.workflows]: "name-asc",
		});
	});
});
