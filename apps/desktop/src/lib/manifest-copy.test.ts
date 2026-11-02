import { describe, expect, test } from "bun:test";
import { localizeSettingsTab } from "../components/settings/PluginSettingsFields-localize.ts";
import {
	localizeStoreItem,
	localizeStoreSpec,
	localizeStoreTab,
} from "../components/store/ContributedStoreSection-localize.ts";
import { manifestCopy, optionalManifestCopy } from "./manifest-copy.ts";

const DE: Record<string, string> = {
	"Action summaries": "Aktionszusammenfassungen",
	Brief: "Kurz",
	"Daily standup": "Tägliches Stand-up",
	"Delete plan": "Plan löschen",
	"Meeting notes": "Besprechungsnotizen",
	"Note styles": "Notizstile",
	"Use this style": "Diesen Stil verwenden",
};
const tl = (source: string) => DE[source] ?? `[en] ${source}`;

describe("manifestCopy", () => {
	test("translates catalogued copy through the translator", () => {
		expect(manifestCopy(tl, "Brief")).toBe("Kurz");
	});

	test("keeps copy with ICU or mustache braces, and blank copy, verbatim", () => {
		expect(manifestCopy(tl, "Hello {name}")).toBe("Hello {name}");
		expect(manifestCopy(tl, "{{item.title}}")).toBe("{{item.title}}");
		expect(manifestCopy(tl, "  ")).toBe("  ");
		expect(optionalManifestCopy(tl, undefined)).toBeUndefined();
	});
});

describe("manifest copy seams", () => {
	test("localizes a settings tab's title, labels and options", () => {
		const tab = localizeSettingsTab(tl, {
			id: "action-summary",
			title: "Action summaries",
			plugin: "com.fixture",
			enabled: true,
			scope: "user",
			fields: [
				{
					type: "select",
					label: "Brief",
					prefKey: "fixture.mode",
					options: [{ label: "Brief", value: "brief" }],
				},
			],
		});
		expect(tab.title).toBe("Aktionszusammenfassungen");
		expect(tab.fields[0]?.label).toBe("Kurz");
		expect(tab.fields[0]?.options[0]).toEqual({
			label: "Kurz",
			value: "brief",
		});
		expect(tab.fields[0]?.prefKey).toBe("fixture.mode");
	});

	test("localizes a Store tab, its spec copy and its rows without touching requests", () => {
		const http = { method: "POST" as const, path: "/api/meetings/templates" };
		const tab = localizeStoreTab(tl, {
			app_enabled: true,
			app_installed: true,
			id: "notes",
			plugin: "@ryu/meetings",
			subtitle: "Meeting notes",
			title: "Note styles",
		});
		expect([tab.title, tab.subtitle, tab.plugin]).toEqual([
			"Notizstile",
			"Besprechungsnotizen",
			"@ryu/meetings",
		]);
		const spec = localizeStoreSpec(tl, {
			install: { http, label: "Use this style" },
			itemActions: [{ id: "delete", label: "Delete plan", http }],
		});
		expect(spec?.install?.label).toBe("Diesen Stil verwenden");
		expect(spec?.install?.http).toBe(http);
		expect(spec?.itemActions?.[0]?.label).toBe("Plan löschen");
		const item = localizeStoreItem(tl, {
			group: "",
			id: "standup",
			installed: false,
			raw: { id: "standup", name: "Daily standup" },
			tags: [],
			title: "Daily standup",
		});
		expect(item.title).toBe("Tägliches Stand-up");
		expect(item.raw).toEqual({ id: "standup", name: "Daily standup" });
	});
});
