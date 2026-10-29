import { describe, expect, test } from "bun:test";
import {
	parseStandaloneAppBundle,
	parseStandaloneAppRegistry,
	removeStandaloneAppInstallation,
	serializeStandaloneAppRegistry,
	standaloneCompanionId,
	standaloneDataDir,
	standalonePortOffset,
	standalonePortOffsetBounds,
	upsertStandaloneAppInstallation,
} from "./standalone.ts";

describe("standalone app contract", () => {
	test("normalizes bundle labels and retains manifest and sidecar metadata", () => {
		const bundle = {
			appId: " @ryu/expenses ",
			appName: " Expenses ",
			manifest: { permissions: ["file:access"], extension: { enabled: true } },
			schemaVersion: 1 as const,
			sidecars: [
				{
					command: null,
					mode: "embedded" as const,
					name: "processor",
					extension: "kept",
				},
			],
			uiCode: "",
			version: " 1.0.0 ",
		};
		expect(parseStandaloneAppBundle(bundle)).toEqual({
			...bundle,
			appId: "@ryu/expenses",
			appName: "Expenses",
			version: "1.0.0",
		});
		expect(
			parseStandaloneAppBundle({
				...bundle,
				sidecars: [{ ...bundle.sidecars[0], commandEnv: 1 }],
			})
		).toBeNull();
	});

	test("derives a stable isolated port namespace", () => {
		const first = standalonePortOffset("@ryu/expenses");

		expect(first).toBe(standalonePortOffset("@ryu/expenses"));
		expect(first).toBeGreaterThanOrEqual(standalonePortOffsetBounds.min);
		expect(first).toBeLessThanOrEqual(standalonePortOffsetBounds.max);
		expect(first).not.toBe(0);
	});

	test("keeps app data below one platform root without path traversal", () => {
		expect(standaloneDataDir("@ryu/expenses", "/data/Ryu/")).toBe(
			"/data/Ryu/ryu-apps/ryu-expenses"
		);
	});

	test("selects the app-owned Companion and rejects malformed carriage", () => {
		expect(
			standaloneCompanionId(
				[
					{ id: "app__other", pluginId: "@ryu/other" },
					{ id: "app__expenses", pluginId: "@ryu/expenses" },
				],
				"@ryu/expenses"
			)
		).toBe("app__expenses");
		expect(
			parseStandaloneAppBundle({
				schemaVersion: 1,
				appId: "@ryu/expenses",
				appName: "Expenses",
				version: "0.1.0",
				manifest: { id: "@ryu/expenses" },
				sidecars: [],
				uiCode: null,
			})?.appId
		).toBe("@ryu/expenses");
		expect(parseStandaloneAppBundle({ appId: "@ryu/expenses" })).toBeNull();
	});

	test("keeps standalone surfaces separate from the app lifecycle record", () => {
		const installedAt = "2026-09-10T00:00:00.000Z";
		const first = upsertStandaloneAppInstallation([], {
			appId: "@ryu/expenses",
			installedAt,
			version: "1.0.0",
		});
		const refreshed = upsertStandaloneAppInstallation(first, {
			appId: "@ryu/expenses",
			installedAt,
			version: "1.1.0",
		});
		const serialized = serializeStandaloneAppRegistry(refreshed);

		expect(parseStandaloneAppRegistry(serialized)).toEqual([
			{
				appId: "@ryu/expenses",
				installedAt,
				version: "1.1.0",
			},
		]);
		expect(removeStandaloneAppInstallation(refreshed, "@ryu/expenses")).toEqual(
			[]
		);
		expect(parseStandaloneAppRegistry("not json")).toEqual([]);
		expect(
			parseStandaloneAppRegistry(
				JSON.stringify({
					apps: [
						{
							appId: "../../outside",
							installedAt,
							version: "1.0.0",
						},
					],
					schemaVersion: 1,
				})
			)
		).toEqual([]);
	});
});
