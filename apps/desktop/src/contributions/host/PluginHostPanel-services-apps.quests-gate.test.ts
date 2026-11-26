import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { dispatchRpc, type HostServices } from "@ryu/app-host/rpc";
import { buildPluginHostAppServices } from "./PluginHostPanel-services-apps.ts";
import type { PluginHostServicesContext } from "./PluginHostPanel-services-context.ts";

// The real desktop app services, driven through the bridge dispatcher against a
// stand-in for the node. The stand-in replaces the global fetch for this file:
// it answers the quest routes with fixed JSON and opens no socket. No node and
// no Quests sidecar is involved.
//
// The grants quests:crud and quests:capture are approvable for any app id, and
// the board holds text the person kept from other apps. Only the Quests app may
// reach the quest routes; the inbox app gets three verbs with reduced rows.

const NOW = "2026-01-01T00:00:00Z";
const KEPT_TEXT = "kept text from another app";
const SCRATCHPAD = "private scratchpad text";
const FULL_ROW = {
	body: KEPT_TEXT,
	completion_condition: "the private condition",
	created_at: NOW,
	detail: "the private detail",
	id: "q1",
	kind: "snippet",
	pinned: false,
	source: {
		app: "Browser",
		title: "a private window title",
		url: "https://example.test/private",
	},
	status: "open",
	suggestion: {
		confidence: 80,
		evidence: "a private evidence snippet",
		reason: "looks done",
		suggested_at: NOW,
	},
	title: "Ship the report",
	updated_at: NOW,
};
const REDUCED_ROW = {
	completion_condition: "",
	created_at: NOW,
	id: "q1",
	status: "open",
	suggestion: { confidence: 80, reason: "looks done", suggested_at: NOW },
	title: "Ship the report",
	updated_at: NOW,
};

const requests: string[] = [];
const settingsOpened: string[] = [];
const realFetch = globalThis.fetch;

function standInNode(
	input: Parameters<typeof fetch>[0],
	init?: RequestInit
): Promise<Response> {
	const path = new URL(input instanceof Request ? input.url : String(input))
		.pathname;
	requests.push(`${init?.method ?? "GET"} ${path}`);
	if (path === "/api/quests") {
		return Promise.resolve(Response.json({ quests: [FULL_ROW] }));
	}
	if (path === "/api/quests/scratchpad") {
		return Promise.resolve(Response.json({ text: SCRATCHPAD }));
	}
	return Promise.resolve(Response.json({ quest: FULL_ROW }));
}

beforeAll(() => {
	globalThis.fetch = standInNode as unknown as typeof fetch;
});

afterAll(() => {
	globalThis.fetch = realFetch;
});

beforeEach(() => {
	requests.length = 0;
	settingsOpened.length = 0;
});

const GRANTED = new Set(["quests.crud", "quests.capture"] as const);

function servicesFor(pluginId: string): HostServices {
	const context = {
		companion: { id: `app__${pluginId}`, pluginId },
		meId: null,
		node: {
			url: "http://127.0.0.1:9",
			token: "owner-node-token",
			userJwt: null,
		},
		openGateway: (section: string) => {
			settingsOpened.push(section);
		},
		openTab: () => undefined,
	} as unknown as PluginHostServicesContext;
	return buildPluginHostAppServices(context) as HostServices;
}

const call = (pluginId: string, method: string, args: unknown[] = []) =>
	dispatchRpc(method, args, GRANTED, servicesFor(pluginId));

describe("desktop quests owner gate", () => {
	test("a third-party app holding both quest grants reads no quest and no scratchpad", async () => {
		await expect(call("@acme/board", "quests.list")).rejects.toMatchObject({
			code: "denied",
		});
		await expect(
			call("@acme/board", "quests.scratchpad")
		).rejects.toMatchObject({ code: "denied" });
		expect(requests).toEqual([]);
	});

	test("a third-party app holding both quest grants changes nothing on the board", async () => {
		const refused: [method: string, args: unknown[]][] = [
			["quests.delete", [{ id: "q1" }]],
			["quests.complete", [{ id: "q1" }]],
			["quests.setScratchpad", [{ text: "overwritten" }]],
			["quests.capture", [{ body: "planted text" }]],
			["quests.judge", [{ id: "q1" }]],
			["quests.openDetectionSettings", []],
		];
		for (const [method, args] of refused) {
			await expect(call("@acme/board", method, args)).rejects.toMatchObject({
				code: "denied",
			});
		}
		expect(requests).toEqual([]);
		expect(settingsOpened).toEqual([]);
	});

	test("the inbox app gets reduced rows and cannot reach the scratchpad or delete", async () => {
		const reply = await call("@ryu/approvals", "quests.list");
		expect(reply).toEqual([REDUCED_ROW]);
		expect(JSON.stringify(reply)).not.toContain("private");
		expect(JSON.stringify(reply)).not.toContain(KEPT_TEXT);
		expect(
			await call("@ryu/approvals", "quests.acceptSuggestion", [{ id: "q1" }])
		).toEqual(REDUCED_ROW);
		await expect(
			call("@ryu/approvals", "quests.scratchpad")
		).rejects.toMatchObject({ code: "denied" });
		await expect(
			call("@ryu/approvals", "quests.delete", [{ id: "q1" }])
		).rejects.toMatchObject({ code: "denied" });
		expect(requests).toEqual([
			"GET /api/quests",
			"POST /api/quests/q1/suggestion/accept",
		]);
	});

	test("the Quests app still reads its whole board and the scratchpad", async () => {
		expect(await call("@ryu/quests", "quests.list")).toEqual([FULL_ROW]);
		expect(await call("@ryu/quests", "quests.scratchpad")).toBe(SCRATCHPAD);
		await call("@ryu/quests", "quests.openDetectionSettings");
		expect(requests).toEqual(["GET /api/quests", "GET /api/quests/scratchpad"]);
		expect(settingsOpened).toEqual(["app:@ryu/quests"]);
	});
});
