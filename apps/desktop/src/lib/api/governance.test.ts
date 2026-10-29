import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
	fetchGatewayGovernance,
	type GovernanceLayer,
	isGovernanceFieldLocked,
	parseGatewayGovernanceSnapshot,
	resolveGovernanceField,
	updateGatewayGovernance,
} from "./governance.ts";

describe("resolveGovernanceField", () => {
	it("keeps explicit false at the most-specific layer", () => {
		const layers: GovernanceLayer<boolean>[] = [
			{ scope: "node", value: true },
			{ scope: "organization", value: true },
			{ scope: "team", value: undefined },
			{ scope: "user", value: false },
		];

		expect(resolveGovernanceField(layers)).toEqual({
			scope: "user",
			value: false,
		});
	});

	it("inherits the nearest declared broader value", () => {
		const layers: GovernanceLayer<string>[] = [
			{ scope: "node", value: "node/" },
			{ scope: "organization", value: "org/" },
			{ scope: "team", value: undefined },
			{ scope: "user", value: undefined },
		];

		expect(resolveGovernanceField(layers)).toEqual({
			scope: "organization",
			value: "org/",
		});
	});
});

describe("parseGatewayGovernanceSnapshot", () => {
	it("preserves false values and marks unavailable managed layers", () => {
		const parsed = parseGatewayGovernanceSnapshot({
			schemaVersion: 1,
			layers: [
				{
					revision: 4,
					scope: "node",
					values: {
						git: { createDraftPullRequests: true },
						worktrees: { autoDelete: false },
					},
					writable: true,
				},
				{
					revision: 0,
					scope: "organization",
					unavailableReason: "This node is not managed.",
					values: {},
					writable: false,
				},
			],
		});

		expect(parsed.layers[0]?.values.worktrees?.autoDelete).toBe(false);
		expect(parsed.layers[1]?.unavailableReason).toBe(
			"This node is not managed."
		);
	});

	it("parses organization locks and reports locked fields", () => {
		const parsed = parseGatewayGovernanceSnapshot({
			schemaVersion: 1,
			layers: [
				{
					lockedFields: ["git.branchPrefix"],
					revision: 2,
					scope: "organization",
					values: { git: { branchPrefix: "org/" } },
					writable: false,
				},
				{
					lockedFields: "not-a-list",
					revision: 2,
					scope: "user",
					values: {},
					writable: true,
				},
			],
		});

		expect(parsed.layers[0]?.lockedFields).toEqual(["git.branchPrefix"]);
		expect(parsed.layers[1]?.lockedFields).toBeUndefined();
		expect(isGovernanceFieldLocked(parsed, "git.branchPrefix")).toBe(true);
		expect(isGovernanceFieldLocked(parsed, "git.mergeMethod")).toBe(false);
		expect(isGovernanceFieldLocked(undefined, "git.branchPrefix")).toBe(false);
	});

	it("rejects a scope outside the closed hierarchy", () => {
		expect(() =>
			parseGatewayGovernanceSnapshot({
				schemaVersion: 1,
				layers: [
					{
						revision: 1,
						scope: "project",
						values: {},
						writable: true,
					},
				],
			})
		).toThrow("invalid governance scope");
	});
});

describe("governance transport", () => {
	it("fetches the active node snapshot and validates the response", async () => {
		const originalFetch = globalThis.fetch;
		const fakeFetch = Object.assign(
			async (..._args: Parameters<typeof fetch>) =>
				new Response(
					JSON.stringify({
						schemaVersion: 1,
						layers: [
							{
								revision: 1,
								scope: "node",
								values: {},
								writable: true,
							},
						],
					}),
					{ headers: { "content-type": "application/json" }, status: 200 }
				),
			{ preconnect: originalFetch.preconnect }
		);
		globalThis.fetch = fakeFetch;

		try {
			const snapshot = await fetchGatewayGovernance({
				token: "node-token",
				url: "http://127.0.0.1:7980",
				userJwt: null,
			});
			expect(snapshot.layers[0]?.scope).toBe("node");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("writes only the selected local scope and settings kind", async () => {
		const originalFetch = globalThis.fetch;
		let requestBody = "";
		let requestUrl = "";
		const fakeFetch = Object.assign(
			async (...args: Parameters<typeof fetch>) => {
				requestUrl = String(args[0]);
				const init = args[1];
				requestBody = z.string().catch("").parse(init?.body);
				return new Response(JSON.stringify({ schemaVersion: 1, layers: [] }), {
					headers: { "content-type": "application/json" },
					status: 200,
				});
			},
			{ preconnect: originalFetch.preconnect }
		);
		globalThis.fetch = fakeFetch;

		try {
			await updateGatewayGovernance(
				{ token: null, url: "http://127.0.0.1:7980", userJwt: null },
				"git",
				"user",
				{ branchPrefix: "codex/" }
			);
			expect(requestUrl).toEndWith("/api/gateway/governance/git");
			expect(JSON.parse(requestBody)).toEqual({
				scope: "user",
				values: { branchPrefix: "codex/" },
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("governance wire normalization", () => {
	it("keeps null-prototype hook dictionaries and explicit false overrides", () => {
		const input = JSON.parse(
			'{"schemaVersion":1,"layers":[{"revision":0,"scope":"node","writable":true,"values":{"hooks":{"__proto__":{"enabled":false},"future":{"trusted":false,"enabled":"invalid"},"ignored":[]}}}]}'
		);
		const hooks = parseGatewayGovernanceSnapshot(input).layers[0]?.values.hooks;
		expect(Object.getPrototypeOf(hooks)).toBeNull();
		expect(Object.getOwnPropertyDescriptor(hooks, "__proto__")?.value).toEqual({
			enabled: false,
		});
		expect(hooks?.future).toEqual({ trusted: false });
		expect(Object.hasOwn(hooks ?? {}, "ignored")).toBe(false);
	});
	it("keeps per-field invalid fallbacks and declared optional git keys", () => {
		const values = parseGatewayGovernanceSnapshot({
			schemaVersion: 1,
			layers: [
				{
					revision: -1,
					scope: "node",
					writable: false,
					values: {
						git: {
							mergeMethod: "future",
							reviewDelivery: "future",
							alwaysForcePush: false,
						},
						worktrees: { autoDeleteLimit: 0.5, autoDelete: false },
					},
				},
			],
		}).layers[0]?.values;
		expect(values?.git?.mergeMethod).toBeUndefined();
		expect(values?.git?.alwaysForcePush).toBe(false);
		expect(Object.hasOwn(values?.git ?? {}, "branchPrefix")).toBe(true);
		expect(values?.worktrees?.autoDelete).toBe(false);
		expect(values?.worktrees?.autoDeleteLimit).toBeUndefined();
	});
	it("preserves validation errors and their order", () => {
		const input = {
			schemaVersion: 1,
			layers: [
				{ revision: 0.5, writable: "invalid", scope: "future", values: {} },
			],
		};
		expect(() => parseGatewayGovernanceSnapshot(input)).toThrow(
			"invalid governance revision"
		);
		expect(() =>
			parseGatewayGovernanceSnapshot({
				...input,
				layers: [{ ...input.layers[0], revision: 0 }],
			})
		).toThrow("invalid governance writable state");
		expect(() =>
			parseGatewayGovernanceSnapshot({
				...input,
				layers: [{ ...input.layers[0], revision: 0, writable: false }],
			})
		).toThrow("invalid governance scope");
	});
});
