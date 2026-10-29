// apps/desktop/src/lib/api/shadow-computer-use-config.native-http.test.ts
//
// Drives the strict computer-use settings reader across a real HTTP boundary.
// A loopback Bun server stands in for the local Core's `/api/shadow` proxy, and
// the shipping client is imported only after `VITE_CORE_URL` points at it, so
// URL resolution, the local bearer, fetch, and response parsing all run as
// shipped; nothing in the client is stubbed.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { ShadowComputerUseConfig } from "./shadow.ts";

const configPath = "/api/shadow/computer-use/config";
const nodeToken = "shadow-strict-config-test-only-local-bearer";
const previousCoreUrl = process.env.VITE_CORE_URL;
const validConfig = {
	applied: true,
	jevApiKeyConfigured: false,
	planner: "local",
	jevUrl: "https://configured-provider.example.test/decide",
	jevModel: "saved-decision-model",
	layaUrl: "https://preserved-local.example.test/predict",
	localPluginId: "@ryu/saved-local-planner",
	localModelId: "saved-local-model",
	maxSteps: 7,
} satisfies ShadowComputerUseConfig;

let respond: () => Response = () =>
	Response.json({ error: "No reply configured" }, { status: 503 });

// Anything but the local-bearer config read gets an error no test expects.
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const url = new URL(request.url);
		if (
			request.method !== "GET" ||
			url.pathname !== configPath ||
			url.search ||
			request.headers.get("authorization") !== `Bearer ${nodeToken}`
		) {
			return Response.json(
				{
					error: `Undeclared request ${request.method} ${url.pathname}${url.search}`,
				},
				{ status: 503 }
			);
		}
		return respond();
	},
});
process.env.VITE_CORE_URL = server.url.origin;

const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { getShadowComputerUseConfigStrict } = await import("./shadow.ts");
const originalNodeState = useNodeStore.getState();

beforeEach(() => {
	const local = {
		name: "local",
		url: server.url.origin,
		token: nodeToken,
		userJwt: null,
	};
	useNodeStore.setState({ nodes: [local], localNodes: [local] });
});

afterAll(async () => {
	useNodeStore.setState(originalNodeState);
	if (previousCoreUrl === undefined) {
		delete process.env.VITE_CORE_URL;
	} else {
		process.env.VITE_CORE_URL = previousCoreUrl;
	}
	await server.stop(true);
});

describe("getShadowComputerUseConfigStrict", () => {
	test("resolves the parsed settings from a valid Core response", async () => {
		respond = () => Response.json({ ...validConfig, undeclared: "dropped" });

		await expect(getShadowComputerUseConfigStrict()).resolves.toEqual(
			validConfig
		);
	});

	const { maxSteps: _maxSteps, ...missingMaxSteps } = validConfig;
	const malformedBodies: [string, unknown][] = [
		["a non-object body", [validConfig]],
		["an unknown planner", { ...validConfig, planner: "remote" }],
		["a missing required field", missingMaxSteps],
		["a mistyped field", { ...validConfig, applied: "yes" }],
	];
	for (const [label, body] of malformedBodies) {
		test(`rejects ${label} as invalid settings`, async () => {
			respond = () => Response.json(body);

			await expect(getShadowComputerUseConfigStrict()).rejects.toThrow(
				"Core returned invalid Shadow computer-use settings"
			);
		});
	}

	test("rejects a non-OK response with Core's error message", async () => {
		respond = () =>
			Response.json(
				{ error: { message: "Shadow sidecar is not running" } },
				{ status: 502 }
			);

		await expect(getShadowComputerUseConfigStrict()).rejects.toThrow(
			"Shadow sidecar is not running"
		);
	});

	test("rejects a non-OK, non-JSON response with the HTTP status", async () => {
		respond = () => new Response("upstream unavailable", { status: 503 });

		await expect(getShadowComputerUseConfigStrict()).rejects.toThrow(
			"Could not load Shadow computer-use settings (503)"
		);
	});
});
