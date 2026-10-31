import { describe, expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n";
import {
	extensionSummaries,
	implementationSummaries,
	inheritedSurfaceLabel,
	surfaceSupportLabel,
	surfaceSupportRows,
} from "./surface-summary.ts";
import type { AppCatalogItem, PluginCatalogDetail } from "./types.ts";

const entry: AppCatalogItem["entry"] = {
	description: "Browser provider",
	id: "@ryu/browser",
	kinds: ["tool"],
	name: "Browser",
	surface_support: [
		{ surface: "desktop", support: "full" },
		{ inheritedFrom: "desktop", surface: "mobile", support: "limited" },
	],
	tags: ["browser"],
	version: "1.0.0",
};

describe("surface support summaries", () => {
	test("keeps per-surface support and wrapper inheritance", () => {
		expect(surfaceSupportRows(null, entry)).toEqual(
			entry.surface_support ?? []
		);
		expect(
			inheritedSurfaceLabel(
				(source, values) => formatMessage(source, values),
				"desktop"
			)
		).toBe("Uses the shared Desktop shell");
		expect(surfaceSupportLabel("limited")).toBe("Limited");
		expect(surfaceSupportLabel("future-level")).toBe("future-level");
	});

	test("derives browser extension and implementation boundaries", () => {
		const detail: PluginCatalogDetail = {
			apiSurface: {
				provides: [{ capability: "browser.control" }],
				runnables: [
					{ id: "tool", kind: "tool", name: "Browser tool" },
					{ id: "companion", kind: "companion", name: "Browser panel" },
				],
				sidecars: [{ name: "browser", routes: [] }],
				triggers: { turnHooks: [{ event: "context" }] },
			},
		};
		const extensions = extensionSummaries(detail, entry);
		expect(extensions.map((item) => item.target)).toEqual([
			"browser",
			"ryu-shell",
			"core",
		]);
		expect(extensions[0]?.features).toEqual(["browser.control"]);

		const implementation = implementationSummaries(detail, entry);
		expect(implementation.map((item) => item.layer)).toEqual([
			"core",
			"shared-shell",
			"sidecar",
		]);
	});
});
