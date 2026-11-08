import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { dispatchRpc, type HostServices } from "@ryu/app-host/rpc";
import type { PluginHostServicesContext } from "./PluginHostPanel-services-context.ts";
import { buildPluginHostMediaWorkflowServices } from "./PluginHostPanel-services-media-workflows.ts";
import {
	gateWorkflowAuthoring,
	isReviewedWorkflowAuthor,
} from "./workflow-authoring-guard.ts";

// The real Companion workflow services, driven through the bridge dispatcher
// against a recording server standing in for Core. A third-party app holding
// `workflows:crud` / `workflows:runstate` must not reach the owner-token
// `/workflows` authoring and run APIs (a saved Tool node calls any MCP tool as
// the owner with no approval); the reviewed Workflows editor still does.

interface RecordedRequest {
	authorization: string | null;
	method: string;
	path: string;
}

const requests: RecordedRequest[] = [];
const NOW = "2026-01-01T00:00:00Z";

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const path = new URL(request.url).pathname;
		requests.push({
			authorization: request.headers.get("authorization"),
			method: request.method,
			path,
		});
		return Response.json({
			workflow: {
				id: "wf-1",
				name: "x",
				nodes: [],
				edges: [],
				createdAt: NOW,
				updatedAt: NOW,
			},
		});
	},
});

afterAll(() => {
	server.stop(true);
});

beforeEach(() => {
	requests.length = 0;
});

const GRANTED = new Set(["workflows.crud", "workflows.runstate"] as const);

const TOOL_WORKFLOW = {
	name: "escalate",
	nodes: [
		{
			id: "t",
			kind: "tool",
			config: { name: "ghost.click", args: { x: 1, y: 1 } },
		},
	],
	edges: [],
};

function servicesFor(pluginId: string): HostServices {
	const context = {
		companion: { pluginId },
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

describe("workflow authoring guard", () => {
	test("a third-party app cannot save or run owner workflows host-direct", async () => {
		const services = servicesFor("@acme/x");
		await expect(
			dispatchRpc("workflows.save", [TOOL_WORKFLOW], GRANTED, services)
		).rejects.toThrow("reviewed Workflows apps");
		await expect(
			dispatchRpc("workflows.run", [{ id: "wf-1" }], GRANTED, services)
		).rejects.toThrow("reviewed Workflows apps");
		await expect(
			dispatchRpc(
				"workflows.resume",
				[{ runId: "run-1", payload: "{}" }],
				GRANTED,
				services
			)
		).rejects.toThrow("reviewed Workflows apps");
		expect(requests).toEqual([]);
	});

	test("the reviewed Workflows editor still saves and runs", async () => {
		const services = servicesFor("@ryu/workflows");
		const saved = await dispatchRpc(
			"workflows.save",
			[TOOL_WORKFLOW],
			GRANTED,
			services
		);
		expect(saved).toMatchObject({ id: "wf-1" });
		// The stand-in run reply is not a full run record; only the request matters.
		await dispatchRpc(
			"workflows.run",
			[{ id: "wf-1" }],
			GRANTED,
			services
		).catch(() => undefined);
		expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
			"POST /workflows",
			"POST /workflows/wf-1/run",
		]);
	});

	test("reviewed ids match exactly after trim, ignoring case", () => {
		expect(isReviewedWorkflowAuthor(" @RYU/Feedback-Board ")).toBe(true);
		expect(isReviewedWorkflowAuthor("@ryu/workflows-evil")).toBe(false);
		expect(isReviewedWorkflowAuthor("@acme/workflows")).toBe(false);
	});

	test("read-only verbs stay available to every app", () => {
		const list = async () => [];
		const gated = gateWorkflowAuthoring("@acme/x", {
			workflowsList: list,
		});
		expect(gated.workflowsList).toBe(list);
		expect(gated.workflowsSave).toBeUndefined();
	});
});
