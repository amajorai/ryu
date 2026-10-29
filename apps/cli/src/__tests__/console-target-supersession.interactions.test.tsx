/* @jsxImportSource @opentui/react */

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyEvent } from "@opentui/core";
import {
	type AppRequestValue,
	appResponseValueSchema,
} from "@ryuhq/core-client/app-request-json";
import { act } from "react";
import { z } from "zod";
import { App } from "../App.tsx";
import {
	defaultProductModePreference,
	productModePreferencePath,
	withProductMode,
	writeProductModePreference,
} from "../core/productMode.ts";
import { testRender } from "./cli-test-render.ts";
import {
	credentialFreeCoreProbe,
	useFetchBackedLoopback,
} from "./core-identity-fixture.ts";

const TARGET = { url: "http://127.0.0.1:7980", token: "local-node-token" };
const CONTROL_PLANE = "http://localhost:3000";
const OWNER_NODE = {
	name: "Owner",
	orgId: "org-owner",
	url: "https://owner.example.test",
	userJwt: "owner-node-session",
};
const MEMBER_NODE = {
	name: "Member",
	orgId: "org-member",
	url: "https://member.example.test",
	userJwt: "member-node-session",
};
const PERMISSIONS_PATHNAME = "/api/control-plane/me/permissions";
const originalFetch = globalThis.fetch;

// The node's loopback connections go to this file's fetch stub, not sockets.
let restoreLoopback: (() => void) | null = null;
beforeAll(() => {
	restoreLoopback = useFetchBackedLoopback();
});
afterAll(() => {
	restoreLoopback?.();
});

/** Effective permissions the control plane resolves for a built-in role. */
function permissionsForRole(role: "owner" | "admin" | "member"): string[] {
	return role === "member"
		? ["gateway.view", "agent.run"]
		: ["gateway.view", "gateway.configure", "agent.run"];
}
const originalEnvironment = {
	RYU_CLI_CONFIG_DIR: process.env.RYU_CLI_CONFIG_DIR,
	RYU_AUTH_URL: process.env.RYU_AUTH_URL,
};
type RenderedApp = Awaited<ReturnType<typeof testRender>>;
let renderedApp: RenderedApp | null = null;
let testHome: string | null = null;

afterEach(async () => {
	await act(async () => renderedApp?.renderer.destroy());
	renderedApp = null;
	globalThis.fetch = originalFetch;
	for (const [key, value] of Object.entries(originalEnvironment)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	if (testHome) {
		rmSync(testHome, { recursive: true, force: true });
		testHome = null;
	}
});

async function mountApp(): Promise<RenderedApp> {
	let result: RenderedApp | null = null;
	await act(async () => {
		const renderer = await testRender(<App target={TARGET} />, {
			width: 140,
			height: 36,
		});
		result = renderer;
		await renderer.renderOnce();
	});
	if (!result) {
		throw new Error("OpenTUI did not render the CLI App");
	}
	renderedApp = result;
	return result;
}

async function press(
	renderer: RenderedApp,
	name: string,
	modifiers: InputModifiers = {}
): Promise<void> {
	const input = renderer.renderer.keyInput;
	await act(async () => {
		input.emit(
			"keypress",
			new KeyEvent({
				name,
				sequence: name.length === 1 ? name : "",
				ctrl: modifiers.ctrl ?? false,
				shift: modifiers.shift ?? false,
				meta: false,
				option: false,
				eventType: "press",
				repeated: false,
				number: false,
				raw: name.length === 1 ? name : "",
				source: "raw",
			})
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await renderer.renderOnce();
	});
}

async function waitForFrame(
	renderer: RenderedApp,
	predicate: (frame: string) => boolean
): Promise<string> {
	let frame = renderer.captureCharFrame();
	await act(async () => {
		for (let pass = 0; pass < 40 && !predicate(frame); pass += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
			await renderer.renderOnce();
			frame = renderer.captureCharFrame();
		}
	});
	if (!predicate(frame)) {
		throw new Error(`CLI did not reach the expected state:\n${frame}`);
	}
	return frame;
}

function hasMode(
	frame: string,
	mode: "Bot" | "Agent" | "OS" | "Checking"
): boolean {
	return frame
		.split("\n")
		.some(
			(line) =>
				line.includes("Ryu") && line.includes(mode) && line.includes("⌄")
		);
}

interface DeferredOwnerRequest {
	settled: boolean;
	signal: AbortSignal | null;
}
interface InputModifiers {
	ctrl?: boolean;
	shift?: boolean;
}
const stringBodySchema = z.string({
	error: "Expected a primitive request-body string",
});

interface CapturedRequest {
	auth: string | null;
	body: z.infer<typeof appResponseValueSchema>;
	method: string;
	origin: string;
	path: string;
	status: number;
	transportError?: string;
	userJwt: string | null;
}

for (const scenario of [
	{ name: "late-owner-success", rejectOwner: false, revokeSession: false },
	{ name: "late-owner-failure", rejectOwner: true, revokeSession: false },
	{ name: "revoked-session-retry", rejectOwner: true, revokeSession: true },
]) {
	test(`${scenario.name}: previous node authority cannot expose Console after the real node picker selects a member`, async () => {
		const home = mkdtempSync(join(tmpdir(), "ryu-cli-console-target-race-"));
		testHome = home;
		process.env.RYU_CLI_CONFIG_DIR = join(home, ".ryu");
		process.env.RYU_AUTH_URL = CONTROL_PLANE;
		mkdirSync(join(home, ".ryu"), { recursive: true });
		const nodesPath = join(home, ".ryu", "nodes.json");
		const localNodes = {
			default: "local",
			nodes: [{ name: "local", ...TARGET }],
		};
		writeFileSync(nodesPath, JSON.stringify(localNodes));
		const preferencePath = productModePreferencePath(home);
		writeProductModePreference(
			withProductMode(defaultProductModePreference(), "console", "/home"),
			preferencePath
		);
		const requests: CapturedRequest[] = [];
		const unexpected: string[] = [];
		const deferred: DeferredOwnerRequest = {
			signal: null,
			settled: false,
		};
		let completeOwner = (): void => {
			throw new Error("Owner request was not deferred");
		};
		let ownerCheckStarted = false;
		let memberRole: "member" | "admin" = "member";
		let accountRevoked = false;
		globalThis.fetch = Object.assign(
			async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const request = input instanceof Request ? input : null;
				const url = new URL(request?.url ?? String(input));
				const headers = new Headers(init?.headers ?? request?.headers);
				const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
				const captured: CapturedRequest = {
					auth: headers.get("authorization"),
					body: stringBodySchema.safeParse(init?.body).success
						? appResponseValueSchema.parse(JSON.parse(String(init?.body)))
						: null,
					method,
					origin: url.origin,
					path: `${url.pathname}${url.search}`,
					status: 0,
					userJwt: headers.get("x-ryu-user-jwt"),
				};
				requests.push(captured);
				// The local Core answers the credential-free loopback probe and
				// identity challenge before it is sent the node token.
				const probe = credentialFreeCoreProbe(url, method, headers, TARGET);
				if (probe) {
					captured.status = probe.status;
					return probe;
				}
				if (
					url.origin === CONTROL_PLANE &&
					captured.path === "/api/feature-flags/public" &&
					method === "GET" &&
					captured.body === null &&
					captured.auth === null &&
					captured.userJwt === null
				) {
					captured.status = 200;
					return Response.json({
						features: { "waitlist.managed_nodes_only": false },
					});
				}
				const identity =
					url.origin === TARGET.url
						? TARGET.token
						: url.origin === OWNER_NODE.url
							? OWNER_NODE.userJwt
							: url.origin === MEMBER_NODE.url
								? MEMBER_NODE.userJwt
								: url.origin === CONTROL_PLANE
									? "account-session"
									: null;
				const expectedJwt =
					url.origin === OWNER_NODE.url
						? OWNER_NODE.userJwt
						: url.origin === MEMBER_NODE.url
							? MEMBER_NODE.userJwt
							: null;
				const corePath =
					[
						"/api/auth/status",
						"/api/auth/accounts",
						"/api/health",
						"/api/system/status",
						"/api/plugins",
						"/api/plugins/contributions",
						"/api/agents",
						"/api/teams",
						"/api/spaces",
						"/api/meetings",
						"/api/conversations",
						"/workflows",
						"/api/update/check",
						"/api/preferences/auto-updates",
						"/api/preferences/terminal-theme",
						"/api/preferences/theme",
					].includes(captured.path) ||
					(captured.path === "/api/notifications/stream" &&
						expectedJwt !== null);
				const accountPath =
					["/api/control-plane/nodes", "/api/waitlist/me"].includes(
						captured.path
					) || url.pathname === PERMISSIONS_PATHNAME;
				const known =
					method === "GET" &&
					captured.body === null &&
					identity !== null &&
					captured.auth === `Bearer ${identity}` &&
					captured.userJwt === expectedJwt &&
					(url.origin === CONTROL_PLANE ? accountPath : corePath);
				if (!known) {
					unexpected.push(
						`${method} ${url.origin}${captured.path}: invalid origin/auth/method/path/body`
					);
					captured.status = 501;
					return Response.json(
						{ error: "Console race fixture contract refused" },
						{ status: 501 }
					);
				}
				const json = (body: AppRequestValue) => {
					captured.status = 200;
					return Response.json(body);
				};
				if (captured.path === "/api/waitlist/me") {
					return json({ status: "approved" });
				}
				if (
					[
						"/api/teams",
						"/api/spaces",
						"/api/meetings",
						"/api/conversations",
					].includes(captured.path)
				) {
					return json({
						teams: [],
						spaces: [],
						meetings: [],
						conversations: [],
					});
				}
				if (url.pathname === PERMISSIONS_PATHNAME) {
					const requestedOrgId = url.searchParams.get("orgId");
					if (!ownerCheckStarted) {
						ownerCheckStarted = true;
						deferred.signal = init?.signal ?? request?.signal ?? null;
						// Deliver an obsolete response even after its AbortSignal fires.
						// Sequence/target guards must protect the replacement identity too.
						return await new Promise<Response>((resolve, reject) => {
							completeOwner = () => {
								deferred.settled = true;
								if (scenario.rejectOwner) {
									captured.status = 0;
									captured.transportError =
										"Previous owner authority request failed after target replacement";
									reject(
										new Error(
											"Previous owner authority request failed after target replacement"
										)
									);
									return;
								}
								resolve(
									json({
										permissions: permissionsForRole(
											requestedOrgId === OWNER_NODE.orgId ? "owner" : "member"
										),
									})
								);
							};
						});
					}
					return json({
						permissions: permissionsForRole(
							requestedOrgId === OWNER_NODE.orgId ? "owner" : memberRole
						),
					});
				}
				if (captured.path === "/api/control-plane/nodes") {
					return json({ nodes: [OWNER_NODE, MEMBER_NODE] });
				}
				if (captured.path === "/api/auth/status") {
					return json(
						accountRevoked
							? { authenticated: false, token: null }
							: { authenticated: true, token: "account-session" }
					);
				}
				if (captured.path === "/api/auth/accounts") {
					return json({ activeUserId: null, accounts: [] });
				}
				if (captured.path === "/api/notifications/stream") {
					// The mounted App subscribes on delegated nodes. Keep a valid SSE
					// connection open until its production AbortSignal cancels the reader.
					if (!((init?.signal ?? request?.signal) instanceof AbortSignal)) {
						unexpected.push(
							`${method} ${url.href}: notification stream has no cancellation signal`
						);
						throw new Error(
							"Notification stream requires cancellation ownership"
						);
					}
					captured.status = 200;
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(new TextEncoder().encode(": connected\n\n"));
							},
						}),
						{ headers: { "content-type": "text/event-stream" } }
					);
				}
				if (captured.path === "/api/update/check") {
					return json({
						current: "0.4.0",
						latest: "0.4.0",
						update_available: false,
						html_url: null,
					});
				}
				if (captured.path === "/api/preferences/auto-updates") {
					return json({
						key: "auto-updates",
						value: JSON.stringify({ enabled: false }),
					});
				}
				if (
					captured.path === "/api/preferences/theme" ||
					captured.path === "/api/preferences/terminal-theme"
				) {
					return json({
						key: url.pathname.split("/").at(-1),
						value: JSON.stringify("dark"),
					});
				}
				if (captured.path === "/api/health") {
					return json({ status: "ok" });
				}
				if (captured.path === "/api/system/status") {
					return json({
						engine: { active: null, running: false },
						gateway: { reachable: true },
						sidecars: [],
					});
				}
				if (captured.path === "/api/plugins") {
					return json({ apps: [] });
				}
				if (captured.path === "/api/plugins/contributions") {
					return json({ views: [], slash_commands: [] });
				}
				if (captured.path === "/api/agents") {
					return json({ agents: [] });
				}
				if (captured.path === "/workflows") {
					return json({ workflows: [] });
				}
				throw new Error("Known request has no explicit response");
			},
			{ preconnect: originalFetch.preconnect }
		);

		const renderer = await mountApp();
		await waitForFrame(renderer, (frame) => hasMode(frame, "Agent"));
		const authoritativePreference = await Bun.file(preferencePath).text();
		await press(renderer, "n", { ctrl: true });
		await waitForFrame(
			renderer,
			(frame) => frame.includes("cloud-Owner") && frame.includes("cloud-Member")
		);
		await press(renderer, "down");
		await press(renderer, "return");
		await waitForFrame(
			renderer,
			(frame) =>
				ownerCheckStarted &&
				hasMode(frame, "Checking") &&
				frame.includes(`BOT · ${OWNER_NODE.url}`)
		);
		expect(ownerCheckStarted).toBe(true);
		expect(deferred.signal).not.toBeNull();
		expect(deferred.signal?.aborted).toBe(false);
		expect(deferred.settled).toBe(false);

		// Replace the target via the shipped control, not a test-only context setter.
		await press(renderer, "n", { ctrl: true });
		await waitForFrame(
			renderer,
			(frame) => frame.includes("cloud-Owner") && frame.includes("cloud-Member")
		);
		await press(renderer, "down");
		await press(renderer, "return");
		const denied = await waitForFrame(
			renderer,
			(frame) =>
				hasMode(frame, "Bot") &&
				frame.includes(MEMBER_NODE.url) &&
				frame.includes("role grants Gateway configuration") &&
				!frame.includes("Checking Agent access")
		);
		expect(denied).not.toContain("Core overview and Gateway controls.");
		expect(denied).not.toContain("Your local overview");
		expect(deferred.signal?.aborted).toBe(true);
		expect(deferred.settled).toBe(false);
		expect(
			requests.filter(
				(request) =>
					request.path.startsWith(PERMISSIONS_PATHNAME) &&
					request.status === 200
			).length
		).toBeGreaterThan(0);
		expect(await Bun.file(preferencePath).text()).toBe(authoritativePreference);

		await act(async () => {
			completeOwner();
			await new Promise((resolve) => setTimeout(resolve, 0));
			await renderer.flush({ maxPasses: 12 });
		});
		const afterLateOwner = renderer.captureCharFrame();
		expect(deferred.settled).toBe(true);
		expect(hasMode(afterLateOwner, "Bot")).toBe(true);
		expect(afterLateOwner).toContain(MEMBER_NODE.url);
		expect(afterLateOwner).not.toContain("Core overview and Gateway controls.");
		expect(afterLateOwner).not.toContain("Your local overview");
		expect(afterLateOwner).toContain("role grants Gateway configuration");
		expect(requests.filter((request) => request.transportError)).toHaveLength(
			scenario.rejectOwner ? 1 : 0
		);
		expect(await Bun.file(preferencePath).text()).toBe(authoritativePreference);
		expect(await Bun.file(nodesPath).json()).toEqual(localNodes);
		const memberCalls = requests.filter(
			(request) => request.origin === MEMBER_NODE.url
		);
		expect(memberCalls.length).toBeGreaterThan(0);
		for (const request of memberCalls) {
			expect(request).toMatchObject({
				auth: `Bearer ${MEMBER_NODE.userJwt}`,
				userJwt: MEMBER_NODE.userJwt,
			});
		}
		expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
		expect(unexpected).toEqual([]);

		// A revoked account cannot turn B's new admin role into Console access.
		if (scenario.revokeSession) {
			memberRole = "admin";
			accountRevoked = true;
			const revokedStart = requests.length;
			await press(renderer, "r");
			const revoked = await waitForFrame(
				renderer,
				(frame) =>
					hasMode(frame, "Bot") &&
					frame.includes(MEMBER_NODE.url) &&
					frame.includes("requires a signed-in organization member")
			);
			expect(revoked).not.toContain("Core overview and Gateway controls.");
			expect(revoked).not.toContain("Your local overview");
			expect(await Bun.file(preferencePath).text()).toBe(
				authoritativePreference
			);
			expect(await Bun.file(nodesPath).json()).toEqual(localNodes);
			const revokedCalls = requests.slice(revokedStart);
			expect(
				revokedCalls.some(
					(request) =>
						request.origin === TARGET.url &&
						request.path === "/api/auth/status" &&
						request.status === 200 &&
						request.auth === `Bearer ${TARGET.token}` &&
						request.userJwt === null &&
						request.body === null
				)
			).toBe(true);
			expect(
				revokedCalls.filter((request) =>
					request.path.startsWith(PERMISSIONS_PATHNAME)
				)
			).toEqual([]);
			expect(
				revokedCalls.filter((request) => request.origin === OWNER_NODE.url)
			).toEqual([]);
			expect(
				revokedCalls.filter((request) => request.method !== "GET")
			).toEqual([]);
			expect(unexpected).toEqual([]);
			const proofDir = process.env.RYU_CLI_CONSOLE_SUPERSESSION_PROOF_DIR;
			if (proofDir) {
				mkdirSync(proofDir, { recursive: true });
				writeFileSync(
					join(proofDir, "console-revoked-session-refusal.frame.txt"),
					revoked
				);
			}
			accountRevoked = false;
		}

		// A real retry may enable Console only after a fresh B authority check.
		memberRole = "admin";
		const retryStart = requests.length;
		await press(renderer, "r");
		const retried = await waitForFrame(
			renderer,
			(frame) =>
				hasMode(frame, "Agent") && frame.includes(new URL(MEMBER_NODE.url).host)
		);
		expect(retried).not.toContain("role grants Gateway configuration");
		expect(
			requests
				.slice(retryStart)
				.some(
					(request) =>
						request.origin === CONTROL_PLANE &&
						request.path.startsWith(PERMISSIONS_PATHNAME) &&
						request.status === 200
				)
		).toBe(true);
		expect(
			requests
				.slice(retryStart)
				.filter((request) => request.origin === OWNER_NODE.url)
		).toEqual([]);
		expect(await Bun.file(preferencePath).json()).toMatchObject({
			mode: "console",
			surfaces: { console: "/home" },
		});
		expect(await Bun.file(nodesPath).json()).toEqual(localNodes);
		expect(unexpected).toEqual([]);
		const proofDir = process.env.RYU_CLI_CONSOLE_SUPERSESSION_PROOF_DIR;
		if (proofDir) {
			mkdirSync(proofDir, { recursive: true });
			writeFileSync(
				join(
					proofDir,
					scenario.name === "late-owner-success"
						? "console-member-after-late-owner.frame.txt"
						: `console-member-after-${scenario.name}.frame.txt`
				),
				afterLateOwner
			);
			writeFileSync(
				join(
					proofDir,
					scenario.name === "late-owner-success"
						? "console-member-authorized-retry.frame.txt"
						: `console-member-authorized-retry-${scenario.name}.frame.txt`
				),
				retried
			);
			writeFileSync(
				join(
					proofDir,
					scenario.name === "late-owner-success"
						? "console-target-contracts.json"
						: `console-target-contracts-${scenario.name}.json`
				),
				JSON.stringify({ requests, unexpected }, null, 2)
			);
		}
	});
}
