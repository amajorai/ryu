import { describe, expect, test } from "bun:test";
import {
	ryuCatalogModelsSchema,
	ryuCatalogSnapshotSchema,
} from "./app-bridge.ts";

// Mirrors plugin_host/bridge.rs's catalog_snapshot public projection.
const snapshot = {
	version: 1,
	current: {
		provider: "openai",
		model: null,
		thinkingLevel: null,
		routing: "gateway",
		providerRouting: { openai: "gateway" },
	},
	providers: [
		{
			id: "openai",
			label: "OpenAI",
			api: "responses",
			authKind: "oauth",
			configured: true,
			// No `accounts`: Core never projects saved-account identity into the
			// catalog; it is only reachable through `subscriptions:read`.
			modelOverrides: { "gpt-5": true },
			suggestedModels: ["gpt-5"],
			routing: "gateway",
		},
	],
	agents: [
		{
			id: "ryu",
			name: "Ryu",
			title: null,
			description: null,
			installed: true,
			model: null,
			engine: null,
			transport: null,
			recommended: null,
			enabled: true,
			gatewayBypass: false,
			installHint: "Install with Core",
			versionStatus: "current",
			safetyProfile: { level: "standard" },
		},
	],
	plugins: [
		{
			id: "app",
			name: "App",
			version: "1",
			enabled: false,
			compatible: false,
			compatibility: {
				compatible: false,
				unmet: [{ requirement: "core", expected: "2", actual: "1" }],
			},
			hasCompanion: true,
			runnableCount: 0,
			hookCount: 1,
			hookEventCount: 1,
		},
	],
	hooks: [
		{
			pluginId: "app",
			hookId: "hook",
			on: "turn.end",
			priority: 5,
			enabled: false,
		},
	],
	hookEvents: [
		{
			pluginId: "app",
			id: "event",
			title: "Event",
			description: null,
			payloadExample: { nested: [null, true] },
			enabled: false,
		},
	],
	thinkingLevels: ["low"],
	apiTypes: ["responses"],
	futureMetadata: { revision: 2 },
};

describe("catalog wire contracts", () => {
	test("retains Core metadata, nullable agent fields, and compatibility details", () => {
		expect(ryuCatalogSnapshotSchema.parse(snapshot)).toEqual(snapshot);
	});
	test("rejects invalid nested catalog fields before exposing them to a host", () => {
		for (const invalid of [
			{
				...snapshot,
				current: { ...snapshot.current, providerRouting: { openai: true } },
			},
			{
				...snapshot,
				providers: [
					{ ...snapshot.providers[0], modelOverrides: { "gpt-5": "yes" } },
				],
			},
			{ ...snapshot, agents: [{ id: "ryu", name: "Ryu", enabled: "yes" }] },
			{ ...snapshot, hooks: [{ ...snapshot.hooks[0], priority: "high" }] },
			{
				...snapshot,
				hookEvents: [{ ...snapshot.hookEvents[0], payloadExample: () => {} }],
			},
			{
				...snapshot,
				plugins: [
					{
						...snapshot.plugins[0],
						compatibility: { compatible: false, unmet: [() => {}] },
					},
				],
			},
		]) {
			expect(ryuCatalogSnapshotSchema.safeParse(invalid).success).toBe(false);
		}
	});
	test("accepts minimal discovery models and retains additional public labels", () => {
		const models = {
			providerId: "openai",
			source: "discovery",
			models: [
				{ id: "gpt-5" },
				{ id: "gpt-5-mini", name: "Mini", contextWindow: 128_000 },
			],
		};
		expect(ryuCatalogModelsSchema.parse(models)).toEqual(models);
		expect(
			ryuCatalogModelsSchema.safeParse({ ...models, models: [{ id: 123 }] })
				.success
		).toBe(false);
		expect(
			ryuCatalogModelsSchema.safeParse({ ...models, source: null }).success
		).toBe(false);
	});
});
