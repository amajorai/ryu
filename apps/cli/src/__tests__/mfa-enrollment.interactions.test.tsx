/* @jsxImportSource @opentui/react */

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { act, useEffect } from "react";
import { AUTH_BACKEND_URL } from "../core/authBackend.ts";
import { CoreProvider, useCore } from "../core/CoreContext.tsx";
import {
	disposeCliIdentity,
	getCliIdentitySnapshot,
	installCliIdentity,
	refreshCliIdentityAfterAccountChange,
} from "../core/identity.ts";
import {
	defaultProductModePreference,
	productModePreferencePath,
	withProductMode,
	writeProductModePreference,
} from "../core/productMode.ts";
import { CLI_GATE_DEADLINES, FRONTEND_URL } from "../core/waitlist.ts";
import { testRender } from "./cli-test-render.ts";

// Handing the link to the system browser is the one effect a frame cannot
// show, so the gate's opener is observed instead of spawning a real browser.
const openedUrls: string[] = [];
mock.module("../core/openBrowser.ts", () => ({
	openBrowser: (url: string | null) => {
		if (url) {
			openedUrls.push(url);
		}
	},
}));
const { App } = await import("../App.tsx");
const { WaitlistGate } = await import("../components/WaitlistGate.tsx");

const NODE_A: ApiTarget = { url: "http://127.0.0.1:7980", token: null };
const NODE_B: ApiTarget = { url: "http://127.0.0.1:7981", token: null };
const SETUP_URL = `${FRONTEND_URL.replace(/\/+$/, "")}/settings/setup-2fa`;
const ENROLLMENT_TITLE = "Set up two-factor authentication";
const WORKSPACE = "Ask anything";
const realFetch = globalThis.fetch;
const originalNodeEnv = process.env.NODE_ENV;
const originalConfigDir = process.env.RYU_CLI_CONFIG_DIR;
type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | null = null;
let configDir: string | undefined;

interface EnrollmentRead {
	authorization: string | null;
	origin: string;
	signal: AbortSignal | null;
}

type EnrollmentAnswer = (
	signal: AbortSignal | null
) => Promise<Response> | Response;

/** A control plane that never answers; the read ends only when it is aborted. */
const answerNever: EnrollmentAnswer = (signal) =>
	new Promise((_resolve, reject) => {
		signal?.addEventListener("abort", () => reject(signal.reason), {
			once: true,
		});
	});

/** The gate with the enrollment read cut short, so a hung read ends quickly. */
const SHORT_ENROLLMENT_DEADLINES = {
	...CLI_GATE_DEADLINES,
	enrollmentMs: 30,
};

/** Let the shortened enrollment deadline pass, with React tracking the update. */
async function outlastEnrollmentDeadline(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) =>
			setTimeout(resolve, SHORT_ENROLLMENT_DEADLINES.enrollmentMs * 4)
		);
	});
}

/** Control plane and Core nodes: which account each node holds, and how the
 * control plane answers that account's enrollment status. */
interface FakeAccounts {
	enrollment: Map<string, EnrollmentAnswer>;
	nodeAccount: Map<string, string | null>;
}

function installFakeServers(accounts: FakeAccounts): EnrollmentRead[] {
	const reads: EnrollmentRead[] = [];
	const provide = async (
		...[input, init]: Parameters<typeof realFetch>
	): Promise<Response> => {
		const url = new URL(String(input));
		if (url.pathname === "/api/auth/status") {
			const token = accounts.nodeAccount.get(url.origin) ?? null;
			// Core's /api/auth/status publisher always serializes all five fields.
			return Response.json({
				authenticated: token !== null,
				pending: false,
				token,
				userCode: null,
				verificationUri: null,
			});
		}
		if (url.pathname === "/api/waitlist/me") {
			return Response.json({ status: "approved" });
		}
		if (url.pathname === "/api/auth/mfa-enrollment/status") {
			const authorization = new Headers(init?.headers).get("authorization");
			reads.push({
				authorization,
				origin: url.origin,
				signal: init?.signal ?? null,
			});
			const token = authorization?.replace(/^Bearer /, "") ?? "";
			const answer = accounts.enrollment.get(token);
			if (!answer) {
				throw new Error(`No enrollment answer for ${token}`);
			}
			return await answer(init?.signal ?? null);
		}
		return Response.json({});
	};
	globalThis.fetch = Object.assign(provide, {
		preconnect: realFetch.preconnect,
	});
	return reads;
}

async function waitFor(
	renderer: Setup,
	predicate: (frame: string) => boolean
): Promise<string> {
	const giveUpAt = Date.now() + 3000;
	let frame = renderer.captureCharFrame();
	while (!predicate(frame) && Date.now() < giveUpAt) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await renderer.renderOnce();
		frame = renderer.captureCharFrame();
	}
	if (!predicate(frame)) {
		throw new Error(`Enrollment gate render did not match: ${frame}`);
	}
	return frame;
}

/** Exposes the Core provider's node switch, as the Services tab uses it. */
let selectNode: ((next: ApiTarget) => void) | null = null;
function NodeSelector() {
	const { setTarget } = useCore();
	useEffect(() => {
		selectNode = setTarget;
		return () => {
			selectNode = null;
		};
	}, [setTarget]);
	return null;
}

beforeEach(() => {
	process.env.NODE_ENV = "production";
	openedUrls.length = 0;
	configDir = mkdtempSync(join(tmpdir(), "ryu-mfa-enrollment-state-"));
	process.env.RYU_CLI_CONFIG_DIR = configDir;
	writeProductModePreference(
		withProductMode(defaultProductModePreference(), "console", "/chat"),
		productModePreferencePath()
	);
});

afterEach(async () => {
	await act(async () => {
		setup?.renderer.destroy();
		await Promise.resolve();
	});
	setup = null;
	disposeCliIdentity();
	globalThis.fetch = realFetch;
	if (originalNodeEnv === undefined) {
		Reflect.deleteProperty(process.env, "NODE_ENV");
	} else {
		process.env.NODE_ENV = originalNodeEnv;
	}
	if (originalConfigDir === undefined) {
		delete process.env.RYU_CLI_CONFIG_DIR;
	} else {
		process.env.RYU_CLI_CONFIG_DIR = originalConfigDir;
	}
	if (configDir) {
		rmSync(configDir, { recursive: true, force: true });
	}
	configDir = undefined;
});

test("MFA enrollment gate shows the setup page and Enter opens it in the browser", async () => {
	const reads = installFakeServers({
		enrollment: new Map([
			["unenrolled-token", () => Response.json({ required: true })],
		]),
		nodeAccount: new Map([[new URL(NODE_A.url).origin, "unenrolled-token"]]),
	});
	setup = await testRender(<App target={NODE_A} />, { width: 140, height: 36 });
	const renderer = setup;

	const frame = await waitFor(renderer, (current) =>
		current.includes(ENROLLMENT_TITLE)
	);
	expect(frame).toContain("passkey or an authenticator app");
	expect(frame).toContain("Email codes don't count.");
	expect(frame).toContain(SETUP_URL);
	expect(frame).toContain("Wrong account?");
	expect(frame).toContain("`ryu-cli logout`");
	expect(frame).toContain(
		"Enter open in browser · r check again · Ctrl+C quit"
	);
	expect(frame).not.toContain(WORKSPACE);
	expect(reads[0]).toMatchObject({
		authorization: "Bearer unenrolled-token",
		origin: AUTH_BACKEND_URL,
	});

	await act(async () => {
		renderer.mockInput.pressEnter();
	});
	const opened = await waitFor(renderer, (current) =>
		current.includes("Finish in your browser")
	);
	expect(openedUrls).toEqual([SETUP_URL]);
	expect(opened).toContain(ENROLLMENT_TITLE);
	expect(opened).not.toContain(WORKSPACE);
});

test("MFA enrollment gate admits the workspace when the account is enrolled", async () => {
	const reads = installFakeServers({
		enrollment: new Map([
			["enrolled-token", () => Response.json({ required: false })],
		]),
		nodeAccount: new Map([[new URL(NODE_A.url).origin, "enrolled-token"]]),
	});
	setup = await testRender(<App target={NODE_A} />, { width: 140, height: 36 });

	const frame = await waitFor(setup, (current) => current.includes(WORKSPACE));
	expect(frame).not.toContain(ENROLLMENT_TITLE);
	expect(reads[0]?.authorization).toBe("Bearer enrolled-token");
});

test("MFA enrollment gate keeps the workspace open when the status cannot be read", async () => {
	const reads = installFakeServers({
		enrollment: new Map([
			[
				"account-token",
				() => {
					throw new TypeError("fetch failed");
				},
			],
		]),
		nodeAccount: new Map([[new URL(NODE_A.url).origin, "account-token"]]),
	});
	setup = await testRender(<App target={NODE_A} />, { width: 140, height: 36 });

	const frame = await waitFor(setup, (current) => current.includes(WORKSPACE));
	expect(frame).not.toContain(ENROLLMENT_TITLE);
	expect(reads).toHaveLength(1);
});

test("MFA enrollment gate opens the workspace when the status read outlasts its deadline", async () => {
	const reads = installFakeServers({
		enrollment: new Map([["account-token", answerNever]]),
		nodeAccount: new Map([[new URL(NODE_A.url).origin, "account-token"]]),
	});
	setup = await testRender(
		<CoreProvider initial={NODE_A}>
			<WaitlistGate deadlines={SHORT_ENROLLMENT_DEADLINES}>
				<text>Workspace ready</text>
			</WaitlistGate>
		</CoreProvider>,
		{ width: 100, height: 30 }
	);

	await outlastEnrollmentDeadline();
	const frame = await waitFor(setup, (current) =>
		current.includes("Workspace ready")
	);
	expect(frame).not.toContain(ENROLLMENT_TITLE);
	expect(reads).toHaveLength(1);
	expect(reads[0]?.signal?.aborted).toBe(true);
});

test("MFA enrollment gate r opens the workspace when the re-read outlasts its deadline", async () => {
	let enrollmentReads = 0;
	installFakeServers({
		enrollment: new Map<string, EnrollmentAnswer>([
			[
				"account-token",
				(signal) => {
					enrollmentReads += 1;
					return enrollmentReads === 1
						? Response.json({ required: true })
						: answerNever(signal);
				},
			],
		]),
		nodeAccount: new Map([[new URL(NODE_A.url).origin, "account-token"]]),
	});
	setup = await testRender(
		<CoreProvider initial={NODE_A}>
			<WaitlistGate deadlines={SHORT_ENROLLMENT_DEADLINES}>
				<text>Workspace ready</text>
			</WaitlistGate>
		</CoreProvider>,
		{ width: 100, height: 30 }
	);
	const renderer = setup;
	await waitFor(renderer, (current) => current.includes(ENROLLMENT_TITLE));

	await act(async () => {
		renderer.mockInput.pressKey("r");
	});
	await outlastEnrollmentDeadline();
	const frame = await waitFor(renderer, (current) =>
		current.includes("Workspace ready")
	);
	expect(frame).not.toContain(ENROLLMENT_TITLE);
	expect(enrollmentReads).toBe(2);
});

test("MFA enrollment gate leaves signed-out use alone", async () => {
	const reads = installFakeServers({
		enrollment: new Map(),
		nodeAccount: new Map([[new URL(NODE_A.url).origin, null]]),
	});
	setup = await testRender(<App target={NODE_A} />, { width: 140, height: 36 });

	await waitFor(setup, (current) => current.includes(WORKSPACE));
	expect(reads).toHaveLength(0);
});

test("MFA enrollment gate r checks again and admits the workspace once a factor is enrolled", async () => {
	const secondRead = Promise.withResolvers<Response>();
	let enrollmentReads = 0;
	installFakeServers({
		enrollment: new Map([
			[
				"account-token",
				() => {
					enrollmentReads += 1;
					return enrollmentReads === 1
						? Response.json({ required: true })
						: secondRead.promise;
				},
			],
		]),
		nodeAccount: new Map([[new URL(NODE_A.url).origin, "account-token"]]),
	});
	setup = await testRender(<App target={NODE_A} />, { width: 140, height: 36 });
	const renderer = setup;
	await waitFor(renderer, (current) => current.includes(ENROLLMENT_TITLE));

	await act(async () => {
		renderer.mockInput.pressKey("r");
	});
	// The setup screen stays up while the status is re-read.
	const checking = await waitFor(renderer, (current) =>
		current.includes("Checking two-factor status…")
	);
	expect(checking).toContain(ENROLLMENT_TITLE);
	expect(enrollmentReads).toBe(2);

	await act(async () => {
		secondRead.resolve(Response.json({ required: false }));
		for (let tick = 0; tick < 5; tick += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	});
	const workspace = await waitFor(renderer, (current) =>
		current.includes(WORKSPACE)
	);
	expect(workspace).not.toContain(ENROLLMENT_TITLE);
	expect(enrollmentReads).toBe(2);
});

test("MFA enrollment gate re-checks when the signed-in account changes", async () => {
	const nodeOrigin = new URL(NODE_A.url).origin;
	const accounts: FakeAccounts = {
		enrollment: new Map([
			["first-account", () => Response.json({ required: true })],
			["second-account", () => Response.json({ required: false })],
		]),
		nodeAccount: new Map([[nodeOrigin, "first-account"]]),
	};
	const reads = installFakeServers(accounts);
	await installCliIdentity(NODE_A);
	setup = await testRender(<App target={NODE_A} />, { width: 140, height: 36 });
	const renderer = setup;
	await waitFor(renderer, (current) => current.includes(ENROLLMENT_TITLE));
	const readsBeforeSwitch = reads.length;

	// The Account tab switches Core's active account, then announces the change.
	accounts.nodeAccount.set(nodeOrigin, "second-account");
	await act(async () => {
		await refreshCliIdentityAfterAccountChange();
	});
	const frame = await waitFor(renderer, (current) =>
		current.includes(WORKSPACE)
	);
	expect(frame).not.toContain(ENROLLMENT_TITLE);
	expect(reads).toHaveLength(readsBeforeSwitch + 1);
	expect(reads.at(-1)?.authorization).toBe("Bearer second-account");
});

test("MFA enrollment gate does not re-check on identity keep-fresh retries for the same account", async () => {
	const reads = installFakeServers({
		enrollment: new Map([
			["unenrolled-token", () => Response.json({ required: true })],
		]),
		nodeAccount: new Map([[new URL(NODE_A.url).origin, "unenrolled-token"]]),
	});
	// An unenrolled account cannot mint a user JWT, so the keep-fresh timer
	// keeps retrying the exchange for the same account.
	await installCliIdentity(NODE_A, { keepFresh: true, refreshIntervalMs: 40 });
	setup = await testRender(<App target={NODE_A} />, { width: 140, height: 36 });
	const renderer = setup;
	await waitFor(renderer, (current) => current.includes(ENROLLMENT_TITLE));
	const readsOnScreen = reads.length;
	const before = getCliIdentitySnapshot();

	// Three retries, each published as refreshing and then settled.
	const frame = await waitFor(
		renderer,
		() => getCliIdentitySnapshot().version >= before.version + 6
	);
	expect(frame).toContain(ENROLLMENT_TITLE);
	expect(getCliIdentitySnapshot().accountGeneration).toBe(
		before.accountGeneration
	);
	expect(reads).toHaveLength(readsOnScreen);
});

test("MFA enrollment gate re-checks a newly selected node and ignores the old node's late answer", async () => {
	const lateAnswer = Promise.withResolvers<Response>();
	const reads = installFakeServers({
		enrollment: new Map<string, EnrollmentAnswer>([
			["node-a-account", () => lateAnswer.promise],
			["node-b-account", () => Response.json({ required: false })],
		]),
		nodeAccount: new Map([
			[new URL(NODE_A.url).origin, "node-a-account"],
			[new URL(NODE_B.url).origin, "node-b-account"],
		]),
	});
	setup = await testRender(
		<CoreProvider initial={NODE_A}>
			<NodeSelector />
			<WaitlistGate>
				<text>Workspace ready</text>
			</WaitlistGate>
		</CoreProvider>,
		{ width: 100, height: 30 }
	);
	const renderer = setup;
	await waitFor(renderer, () => reads.length === 1);
	const nodeARead = reads[0];
	expect(nodeARead?.authorization).toBe("Bearer node-a-account");
	expect(nodeARead?.signal?.aborted).toBe(false);

	await act(async () => {
		selectNode?.(NODE_B);
	});
	await waitFor(renderer, (current) => current.includes("Workspace ready"));
	expect(nodeARead?.signal?.aborted).toBe(true);
	expect(reads.at(-1)?.authorization).toBe("Bearer node-b-account");

	// Node A's answer arrives after the switch; it must not lock node B out.
	lateAnswer.resolve(Response.json({ required: true }));
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	await renderer.renderOnce();
	const frame = renderer.captureCharFrame();
	expect(frame).toContain("Workspace ready");
	expect(frame).not.toContain(ENROLLMENT_TITLE);
});
