/* @jsxImportSource @opentui/react */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyEvent } from "@opentui/core";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { act } from "react";
import { App } from "../App.tsx";
import { authBackendUrl } from "../core/controlPlane.ts";
import { testRender } from "./cli-test-render.ts";

interface ManagedNodeCloudRequestObservation {
	headers: Headers;
	path: string;
}

const TARGET = { url: "http://127.0.0.1:7980", token: null };
const realFetch = globalThis.fetch;
const originalConfigDir = process.env.RYU_CLI_CONFIG_DIR;
type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | null = null;
let isolatedHome: string | null = null;

const originalAuthUrl = process.env.RYU_AUTH_URL;

beforeEach(() => {
	// These flows use a configured local account service. The unconfigured
	// loopback default is never sent account credentials (core/authBackend.ts).
	process.env.RYU_AUTH_URL = "http://localhost:3000";
});

afterEach(() => {
	if (originalAuthUrl === undefined) {
		delete process.env.RYU_AUTH_URL;
	} else {
		process.env.RYU_AUTH_URL = originalAuthUrl;
	}
});

afterEach(async () => {
	globalThis.fetch = realFetch;
	await act(async () => {
		setup?.renderer.destroy();
		await Promise.resolve();
	});
	setup = null;
	if (isolatedHome) {
		rmSync(isolatedHome, { force: true, recursive: true });
		isolatedHome = null;
	}
	if (originalConfigDir === undefined) {
		delete process.env.RYU_CLI_CONFIG_DIR;
	} else {
		process.env.RYU_CLI_CONFIG_DIR = originalConfigDir;
	}
});

interface KeyInput {
	ctrl?: boolean;
	name: string;
	shift?: boolean;
}

async function press(render: Setup, key: KeyInput): Promise<void> {
	const keyInput = render.renderer.keyInput;
	await act(async () => {
		keyInput.emit(
			"keypress",
			new KeyEvent({
				name: key.name,
				sequence: key.name.length === 1 ? key.name : "",
				ctrl: key.ctrl ?? false,
				shift: key.shift ?? false,
				meta: false,
				option: false,
				eventType: "press",
				repeated: false,
				number: false,
				raw: key.name.length === 1 ? key.name : "",
				source: "raw",
			})
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await render.renderOnce();
	});
}

async function waitForFrame(
	render: Setup,
	predicate: (frame: string) => boolean,
	maxPasses = 40
): Promise<string> {
	let frame = render.captureCharFrame();
	await act(async () => {
		for (let pass = 0; pass < maxPasses && !predicate(frame); pass += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
			await render.renderOnce();
			frame = render.captureCharFrame();
		}
	});
	if (!predicate(frame)) {
		throw new Error(`Node picker did not reach expected state:\n${frame}`);
	}
	return frame;
}

test("node picker can use a managed node in-session without persisting its scoped credential", async () => {
	isolatedHome = mkdtempSync(join(tmpdir(), "ryu-cli-managed-node-"));
	process.env.RYU_CLI_CONFIG_DIR = join(isolatedHome, ".ryu");
	const configPath = join(isolatedHome, ".ryu", "nodes.json");
	const initialConfig = {
		default: "local",
		nodes: [{ name: "local", url: TARGET.url, token: null }],
	};
	mkdirSync(join(isolatedHome, ".ryu"), { recursive: true });
	writeFileSync(configPath, JSON.stringify(initialConfig));
	writeFileSync(
		join(isolatedHome, ".ryu", "cli-product-mode.json"),
		JSON.stringify({
			mode: "os",
			surfaces: {
				bot: "/chat",
				console: "/chat",
				os: "/chat",
			},
			version: 1,
		})
	);

	const cloudRequests: ManagedNodeCloudRequestObservation[] = [];
	globalThis.fetch = Object.assign(
		async (
			input: Parameters<typeof realFetch>[0],
			init?: Parameters<typeof realFetch>[1]
		) => {
			const url = new URL(String(input));
			const headers = new Headers(init?.headers);
			if (url.pathname === "/api/auth/status") {
				return Response.json({
					authenticated: true,
					token: "control-plane-session",
				});
			}
			if (
				url.origin === new URL(authBackendUrl()).origin &&
				url.pathname === "/api/control-plane/nodes"
			) {
				expect(headers.get("authorization")).toBe(
					"Bearer control-plane-session"
				);
				return Response.json({
					nodes: [
						{
							id: "cloud-credential",
							name: "Primary",
							orgId: "org-1",
							url: "https://cloud.example.test",
							userJwt: "node-scoped-session",
						},
					],
				});
			}
			if (url.pathname === "/api/health") {
				return Response.json({ status: "ok" });
			}
			if (url.hostname === "cloud.example.test") {
				cloudRequests.push({ headers, path: url.pathname });
				if (url.pathname === "/api/agents") {
					return Response.json({
						agents: [
							{
								id: "managed-agent",
								name: "Managed Agent",
								transport: "acp",
								engine: "claude",
							},
						],
					});
				}
				return Response.json({});
			}
			return Response.json({});
		},
		{ preconnect: realFetch.preconnect }
	);

	await act(async () => {
		const rendered = await testRender(<App target={TARGET} />, {
			width: 180,
			height: 40,
		});
		setup = rendered;
		await rendered.renderOnce();
	});
	if (!setup) {
		throw new Error("OpenTUI did not render the CLI app");
	}
	const renderer = setup;

	await press(renderer, { name: "n", ctrl: true });
	await waitForFrame(renderer, (frame) => frame.includes("cloud-Primary"));
	const picker = await waitForFrame(
		renderer,
		(frame) => frame.includes("cloud-Primary") && frame.includes("[managed]")
	);
	expect(picker).toContain("managed nodes are session-only");

	await press(renderer, { name: "down" });
	await press(renderer, { name: "return" });
	await press(renderer, { name: "k", ctrl: true });
	for (const character of "agents") {
		await press(renderer, { name: character });
	}
	await press(renderer, { name: "return" });
	const agents = await waitForFrame(
		renderer,
		(frame) => frame.includes("Managed Agent") && frame.includes("configured")
	);
	expect(agents).toContain("Managed Agent");

	const cloudAgentRequest = cloudRequests.find(
		(request) => request.path === "/api/agents"
	);
	expect(cloudAgentRequest).toBeDefined();
	expect(cloudAgentRequest?.headers.get("authorization")).toBe(
		"Bearer node-scoped-session"
	);
	expect(cloudAgentRequest?.headers.get("x-ryu-user-jwt")).toBe(
		"node-scoped-session"
	);
	expect(
		appResponseValueSchema.parse(JSON.parse(readFileSync(configPath, "utf8")))
	).toEqual(initialConfig);
	expect(readFileSync(configPath, "utf8")).not.toContain("node-scoped-session");
});
