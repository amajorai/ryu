import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { dispatchRpc, type HostServices } from "@ryu/app-host/rpc";
import type { PluginHostServicesContext } from "./PluginHostPanel-services-context.ts";
import { buildPluginHostMediaWorkflowServices } from "./PluginHostPanel-services-media-workflows.ts";

// The real Companion services, driven through the bridge dispatcher against a
// stand-in for the node. The stand-in is this file's own listener on a loopback
// port: it answers the three record routes with fixed JSON and captures nothing.
// No node, no recorder process and no input hook is involved in this file.
//
// `ghost:record` is approvable for any app id, and a recording returns what the
// person typed anywhere on the desktop. Only the compiled reviewed owners may
// reach the record routes, and only the frame that started a recording reads it.

const requests: string[] = [];
const NOW = "2026-01-01T00:00:00Z";

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const path = new URL(request.url).pathname;
		requests.push(`${request.method} ${path}`);
		if (path.endsWith("/record/start")) {
			return Response.json({
				recording: true,
				started_at: NOW,
				task: "stand-in task",
			});
		}
		if (path.endsWith("/record/status")) {
			return Response.json({
				recording: true,
				started_at: NOW,
				status: { event_count: 2 },
				task: "stand-in task",
			});
		}
		return Response.json({
			event_count: 1,
			events: [{ event_type: "typeText", key: "stand-in text", ts_ms: 1 }],
			recording: false,
			started_at: NOW,
			task: "stand-in task",
		});
	},
});

afterAll(() => {
	server.stop(true);
});

beforeEach(() => {
	requests.length = 0;
});

const GRANTED = new Set(["ghost.record"] as const);

function servicesFor(
	pluginId: string,
	firstParty: boolean,
	currentTabId = "tab-1"
): HostServices {
	const context = {
		companion: { firstParty, id: `app__${pluginId}`, pluginId },
		currentTabId,
		mediaPermission: undefined,
		node: {
			url: `http://127.0.0.1:${server.port}`,
			token: "owner-node-token",
			userJwt: null,
		},
		tl: (message: string) => message,
	} as unknown as PluginHostServicesContext;
	return buildPluginHostMediaWorkflowServices(context) as HostServices;
}

const start = (services: HostServices) =>
	dispatchRpc(
		"ghost.recordStart",
		[{ task: "stand-in task" }],
		GRANTED,
		services
	);
const status = (services: HostServices) =>
	dispatchRpc("ghost.recordStatus", [], GRANTED, services);
const stop = (services: HostServices) =>
	dispatchRpc("ghost.recordStop", [], GRANTED, services);

describe("desktop ghost recording gate", () => {
	test("a third-party Companion holding ghost:record never reaches the record routes", async () => {
		const services = servicesFor("@acme/x", false);
		await expect(start(services)).rejects.toThrow("reviewed Workflows");
		await expect(status(services)).rejects.toThrow("reviewed Workflows");
		await expect(stop(services)).rejects.toThrow("reviewed Workflows");
		expect(requests).toEqual([]);
	});

	test("an installed app that only claims the Workflows id never reaches them either", async () => {
		const services = servicesFor("@ryu/workflows", false);
		await expect(start(services)).rejects.toThrow("reviewed Workflows");
		await expect(stop(services)).rejects.toThrow("reviewed Workflows");
		expect(requests).toEqual([]);
	});

	test("the compiled Workflows app still records and reads its own result", async () => {
		const services = servicesFor("@ryu/workflows", true);
		expect(await start(services)).toMatchObject({ recording: true });
		expect(await status(services)).toMatchObject({
			status: { event_count: 2 },
			task: "stand-in task",
		});
		expect(await stop(services)).toMatchObject({
			events: [{ key: "stand-in text" }],
			recording: false,
		});
		expect(requests).toEqual([
			"POST /api/recipes/record/start",
			"GET /api/recipes/record/status",
			"POST /api/recipes/record/stop",
		]);
	});

	test("a frame that did not start the recording gets no detail from status and no events from stop", async () => {
		const starter = servicesFor("@ryu/workflows", true, "tab-1");
		const other = servicesFor("@ryu/workflows", true, "tab-2");
		await start(starter);
		expect(await status(other)).toEqual({ recording: true });
		const refusal = await stop(other).catch((error: unknown) => error);
		expect(refusal).toBeInstanceOf(Error);
		expect(String(refusal)).toContain("started somewhere else");
		expect(JSON.stringify(refusal)).not.toContain("stand-in text");
		// The capture was ended on the node, so nothing keeps recording.
		expect(requests.at(-1)).toBe("POST /api/recipes/record/stop");
	});
});
