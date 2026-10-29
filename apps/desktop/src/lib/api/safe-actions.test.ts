import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
	resolveSafeActionsPath,
	safeActionsRequest,
	toSafeActionsBridgePath,
} from "./safe-actions.ts";

describe("resolveSafeActionsPath", () => {
	it("contains valid paths under the fixed Core mount", () => {
		expect(resolveSafeActionsPath("/policies")).toBe(
			"/api/tools/plans/policies"
		);
		expect(resolveSafeActionsPath("/reviews/r-1/approve")).toBe(
			"/api/tools/plans/reviews/r-1/approve"
		);
	});

	it("rejects parser traversal and cross-surface paths", () => {
		for (const path of [
			"/../mcp/tools",
			"/%2e%2e/mcp/tools",
			"//evil.example/x",
			"https://evil.example/x",
			"/receipts?all=1",
			"/receipts#proof",
			"/receipts\\..\\mcp",
		]) {
			expect(resolveSafeActionsPath(path)).toBeNull();
		}
	});

	it("gives the bridge the path relative to the mount", () => {
		expect(
			toSafeActionsBridgePath("/api/tools/plans/reviews/r-1/approve")
		).toBe("/reviews/r-1/approve");
		expect(toSafeActionsBridgePath("/api/tools/plans")).toBe("/");
	});
});

interface ReceivedRequest {
	body: string;
	method: string;
	path: string;
}

const received: ReceivedRequest[] = [];
let bridgeReply = (): Response => Response.json({ result: { ok: true } });
const legacyReply = (): Response => Response.json({ ok: true, legacy: true });

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const path = new URL(request.url).pathname;
		received.push({ body: await request.text(), method: request.method, path });
		return path.endsWith("/host") ? bridgeReply() : legacyReply();
	},
});
const target = {
	token: "fixture-node",
	url: `http://127.0.0.1:${server.port}`,
};
const APP = "@example/plans";
const BRIDGE_PATH = `/api/plugins/${encodeURIComponent(APP)}/host`;

beforeEach(() => {
	received.length = 0;
	bridgeReply = () => Response.json({ result: { ok: true } });
});
afterAll(() => {
	server.stop(true);
});

function hostError(status: number, code: string, message: string): Response {
	return Response.json({ error: { code, message } }, { status });
}

describe("safeActionsRequest", () => {
	it("sends the relative normalized path to Core's bridge", async () => {
		const reply = await safeActionsRequest(target, APP, {
			method: "POST",
			path: "/reviews/r-1/./approve",
			body: { note: "ok" },
		});
		expect(reply).toEqual({ ok: true });
		expect(received).toHaveLength(1);
		expect(received[0]?.path).toBe(BRIDGE_PATH);
		expect(JSON.parse(received[0]?.body ?? "{}")).toEqual({
			method: "safeActions.request",
			args: {
				method: "POST",
				path: "/reviews/r-1/approve",
				body: { note: "ok" },
			},
		});
	});

	it("omits an absent body and defaults to GET", async () => {
		await safeActionsRequest(target, APP, { path: "/reviews" });
		expect(JSON.parse(received[0]?.body ?? "{}").args).toEqual({
			method: "GET",
			path: "/reviews",
		});
	});

	it("never retries a refusal host-direct", async () => {
		for (const [status, code, message] of [
			[403, "denied", "Safe Actions operator access denied"],
			[
				403,
				"denied",
				"capability 'safe-actions:manage' not granted to this app",
			],
			[404, "not_found", "plugin not enabled"],
			[500, "server_error", "Safe Actions request failed"],
			[400, "invalid_args", "safeActions.request path is too long"],
		] as const) {
			received.length = 0;
			bridgeReply = () => hostError(status, code, message);
			await expect(
				safeActionsRequest(target, APP, {
					method: "POST",
					path: "/reviews/r-1/deny",
					body: {},
				})
			).rejects.toThrow(message);
			expect(received.map((entry) => entry.path)).toEqual([BRIDGE_PATH]);
		}
	});

	it("falls back host-direct only on an older Core without the method", async () => {
		bridgeReply = () =>
			hostError(
				400,
				"invalid_args",
				"unknown host method 'safeActions.request'"
			);
		const reply = await safeActionsRequest(target, APP, {
			method: "POST",
			path: "/reviews/r-1/deny",
			body: {},
		});
		expect(reply).toEqual({ ok: true, legacy: true });
		expect(received.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
			`POST ${BRIDGE_PATH}`,
			"POST /api/tools/plans/reviews/r-1/deny",
		]);
	});

	it("refuses a path outside the mount before any request", async () => {
		await expect(
			safeActionsRequest(target, APP, { path: "/../mcp/tools" })
		).rejects.toThrow("outside the Safe Actions API mount");
		expect(received).toHaveLength(0);
	});
});
