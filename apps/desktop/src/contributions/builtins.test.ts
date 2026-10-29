// The legacy short paths (`/calendar`, `/timeline`, `/inbox`, …) used to be twelve
// hardcoded `companionId: "app__<x>-companion"` aliases in `builtins.ts`. They are
// now resolved from the live contributions feed by `resolveCompanionAlias`, so these
// assertions are what stops the table creeping back: every path below must resolve
// WITHOUT the shell naming an app, and must resolve to nothing once the owning app
// stops contributing (i.e. is disabled).
//
// Pure input/output — no DOM, no registry, no React — mirroring `registry.test.ts`.

import { describe, expect, it } from "bun:test";
import type {
	PluginCompanion,
	PluginSidebarButton,
} from "@/src/lib/api/plugins.ts";
import { resolveCompanionAlias, topLevelAlias } from "./companion-alias.ts";

const companion = (
	id: string,
	pluginId: string,
	label: string,
	name = label
): PluginCompanion => ({
	approvedGrants: [],
	defaultCspEnforced: true,
	hasUi: true,
	id,
	label,
	name,
	pluginId,
});

/** The built-in companions whose short paths this file must keep alive, shaped
 *  exactly as Core's `/api/plugins/contributions` serves them. */
const CALENDAR = companion(
	"app__calendar-companion",
	"@ryu/calendar",
	"Calendar"
);
const TIMELINE = companion(
	"app__timeline-companion",
	"@ryu/timeline",
	"Timeline"
);
// Labelled "Inbox" but id-slugged "approvals" — the case that proves resolution
// follows the ID, never the display string. `/inbox` is registered as an explicit
// alias of `/approvals` in `builtins.ts` precisely because of this gap.
const APPROVALS = companion(
	"app__approvals-companion",
	"@ryu/approvals",
	"Inbox",
	"Inbox"
);

const feed = (
	companions: PluginCompanion[],
	buttons: PluginSidebarButton[] = []
) => ({ companions, sidebar_buttons: buttons });

describe("resolveCompanionAlias", () => {
	it("a declared global path selects the launchable companion while contextual routes remain usable", () => {
		const editor = {
			...companion("app__editor-companion", "@ryu/calendar", "Editor"),
			navigationVisible: false,
		};
		const buttons: PluginSidebarButton[] = [
			{
				id: "calendar",
				plugin: "@ryu/calendar",
				target: "/calendar",
				title: "Calendar",
			},
		];
		const enabled = feed([editor, CALENDAR], buttons);
		expect(resolveCompanionAlias(enabled, "/calendar")).toBe(CALENDAR.id);
		expect(resolveCompanionAlias(enabled, "/editor")).toBe(editor.id);
	});

	it("derives a short path from the companion id (`app__<slug>-companion`)", () => {
		const enabled = feed([CALENDAR, TIMELINE]);
		expect(resolveCompanionAlias(enabled, "/calendar")).toBe(CALENDAR.id);
		expect(resolveCompanionAlias(enabled, "/timeline")).toBe(TIMELINE.id);
	});

	it("never matches on the display name — only the id", () => {
		// A route resolved off a translatable label would die on a copy change, so
		// `/inbox` is an explicit alias of `/approvals` in `builtins.ts` instead.
		expect(resolveCompanionAlias(feed([APPROVALS]), "/approvals")).toBe(
			APPROVALS.id
		);
		expect(resolveCompanionAlias(feed([APPROVALS]), "/inbox")).toBeNull();
	});

	it("resolves to nothing when the owning app is disabled", () => {
		// A disabled app contributes no companion at all — the whole point of the
		// deletion: the shell can no longer mount a stale frame for it.
		expect(resolveCompanionAlias(feed([TIMELINE]), "/calendar")).toBeNull();
		expect(resolveCompanionAlias(feed([]), "/inbox")).toBeNull();
	});

	it("returns null for a path no enabled app answers to", () => {
		expect(resolveCompanionAlias(feed([CALENDAR]), "/graph")).toBeNull();
		expect(resolveCompanionAlias(feed([CALENDAR]), "/")).toBeNull();
	});

	it("lets a manifest-declared sidebar_buttons target win over the conventions", () => {
		// Tier 1: the app itself asked to live at `/calendar`, so it takes the path
		// even though the id convention would hand it to the calendar app.
		const buttons: PluginSidebarButton[] = [
			{
				id: "agenda",
				plugin: "@ryu/timeline",
				target: "/calendar",
				title: "Agenda",
			},
		];
		expect(
			resolveCompanionAlias(feed([CALENDAR, TIMELINE], buttons), "/calendar")
		).toBe(TIMELINE.id);
	});

	it("is the only tier that may claim a multi-segment path", () => {
		const buttons: PluginSidebarButton[] = [
			{
				id: "new-skill",
				plugin: "@ryu/calendar",
				target: "/skills/new",
				title: "New skill",
			},
		];
		expect(
			resolveCompanionAlias(feed([CALENDAR], buttons), "/skills/new")
		).toBe(CALENDAR.id);
		// Without a declaration, a deeper path is never guessed from a slug.
		expect(resolveCompanionAlias(feed([CALENDAR]), "/a/calendar")).toBeNull();
	});

	it("ignores a declared target whose owning app is not enabled", () => {
		const buttons: PluginSidebarButton[] = [
			{ id: "x", plugin: "com.ryu.gone", target: "/calendar", title: "Gone" },
		];
		// The declaration survives in the feed only while its app does, but a stale
		// one must fall through to the conventions rather than blank the path.
		expect(resolveCompanionAlias(feed([CALENDAR], buttons), "/calendar")).toBe(
			CALENDAR.id
		);
	});
});

describe("topLevelAlias", () => {
	it("reduces a context-carrying deep link to the app it belongs to", () => {
		// How `/timeline/:ts`, `/meetings/:id` and `/workflows/:id` find their app
		// without naming it — the parameter stays in the mount context.
		expect(topLevelAlias("/timeline/1737164000000")).toBe("/timeline");
		expect(topLevelAlias("/meetings/abc")).toBe("/meetings");
		expect(topLevelAlias("/workflows/new")).toBe("/workflows");
		expect(topLevelAlias("/blueprint/plan-1")).toBe("/blueprint");
		expect(topLevelAlias("/mail/inbox-1")).toBe("/mail");
		expect(topLevelAlias("/monitors/monitor-1")).toBe("/monitors");
		expect(topLevelAlias("/reasoning/policy-1")).toBe("/reasoning");
		expect(topLevelAlias("/rlm/context-1")).toBe("/rlm");
	});
});
