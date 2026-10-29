/* @jsxImportSource @opentui/react */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { KeyEvent } from "@opentui/core";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { act, useState } from "react";
import { z } from "zod";
import { ThemeProvider } from "../../components/ui/theme-provider.tsx";
import { AUTH_BACKEND_URL } from "../core/authBackend.ts";
import { CoreProvider } from "../core/CoreContext.tsx";
import { AccountTab, pollOnce } from "../tabs/account.tsx";
import { ToastHost, ToastProvider } from "../ui/toast.tsx";
import { testRender } from "./cli-test-render.ts";

// Complete user selection envelopes published for account switch and remove.
const accountSelectionFields = z.looseObject({ userId: z.string() });
const accountSelectionObservation = z.custom<
	z.infer<typeof accountSelectionFields> &
		z.infer<typeof appResponseValueSchema>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		accountSelectionFields.safeParse(value).success
);
interface AccountActionObservation {
	body: z.infer<typeof appResponseValueSchema>;
	path: string;
}
function installResponse(
	provide: (
		...args: Parameters<typeof realFetch>
	) => ReturnType<typeof realFetch>
): void {
	globalThis.fetch = Object.assign(provide, {
		preconnect: realFetch.preconnect,
	});
}
// Core's /api/auth/status publisher always serializes all five fields.
function coreAuthStatus(token: string | null) {
	return {
		authenticated: token !== null,
		pending: false,
		token,
		userCode: null,
		verificationUri: null,
	};
}
// Complete Better Auth get-session reply: the CLI validates every required
// session-record and user field the control-plane publisher serializes.
function betterAuthSession(user: {
	email: string;
	emailVerified: boolean;
	id: string;
	name: string;
	twoFactorEnabled: boolean;
}) {
	const timestamp = "2026-01-01T00:00:00.000Z";
	return {
		user: { ...user, createdAt: timestamp, updatedAt: timestamp },
		session: {
			id: `session-${user.id}`,
			userId: user.id,
			token: `session-token-${user.id}`,
			expiresAt: "2027-01-01T00:00:00.000Z",
			createdAt: timestamp,
			updatedAt: timestamp,
		},
	};
}
const PASSWORD_STATUS = {
	hasPassword: true,
	provider: "credential",
	authMethod: "password",
};
const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };
const realFetch = globalThis.fetch;

let setup: Awaited<ReturnType<typeof testRender>> | null = null;

const originalAuthUrl = process.env.RYU_AUTH_URL;

beforeEach(() => {
	// These flows use a configured account service. The unconfigured loopback
	// default is never sent account credentials (core/authBackend.ts).
	process.env.RYU_AUTH_URL = AUTH_BACKEND_URL;
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
});

function Harness() {
	return (
		<ThemeProvider reducedMotion>
			<CoreProvider initial={LOCAL_TARGET}>
				<ToastProvider>
					<AccountTab active />
					<ToastHost />
				</ToastProvider>
			</CoreProvider>
		</ThemeProvider>
	);
}

async function press(
	renderer: Awaited<ReturnType<typeof testRender>>,
	name: string,
	shift = false
): Promise<void> {
	await act(async () => {
		renderer.renderer.keyInput.emit(
			"keypress",
			new KeyEvent({
				name,
				sequence: name.length === 1 ? name : "",
				shift,
				ctrl: false,
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
	});
	await renderer.renderOnce();
}

async function waitFor(
	renderer: Awaited<ReturnType<typeof testRender>>,
	predicate: (frame: string) => boolean
): Promise<string> {
	let frame = renderer.captureCharFrame();
	for (let pass = 0; pass < 30 && !predicate(frame); pass += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await renderer.renderOnce();
		frame = renderer.captureCharFrame();
	}
	if (!predicate(frame)) {
		throw new Error(`Account render did not match: ${frame}`);
	}
	return frame;
}

test("Account refresh, switch, remove, add, sign in, and sign out follow their visible key actions", async () => {
	const accounts = [
		{
			userId: "alpha",
			name: "Alpha One",
			email: "alpha@example.test",
			active: true,
		},
		{
			userId: "beta",
			name: "Beta Two",
			email: "beta@example.test",
			active: false,
		},
	];
	let activeUserId: string | null = "alpha";
	let loginCount = 0;
	let authStatusReads = 0;
	let accountReads = 0;
	const accountBackendReads: Array<{
		origin: string;
		path: string;
		authorization: string | null;
	}> = [];
	const actions: AccountActionObservation[] = [];
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		if (url.pathname === "/api/auth/status") {
			authStatusReads += 1;
			return Response.json(
				coreAuthStatus(activeUserId ? `${activeUserId}-token` : null)
			);
		}
		if (url.pathname === "/api/auth/accounts") {
			accountReads += 1;
			return Response.json({
				accounts: accounts.map((account) => ({
					...account,
					active: account.userId === activeUserId,
				})),
				activeUserId,
			});
		}
		if (url.pathname === "/api/auth/get-session") {
			accountBackendReads.push({
				origin: url.origin,
				path: url.pathname,
				authorization: new Headers(init?.headers).get("authorization"),
			});
			const active = accounts.find(
				(account) => account.userId === activeUserId
			);
			return Response.json(
				active
					? betterAuthSession({
							id: active.userId,
							name: active.name,
							email: active.email,
							emailVerified: true,
							twoFactorEnabled: false,
						})
					: null
			);
		}
		if (url.pathname === "/api/user/password-status") {
			accountBackendReads.push({
				origin: url.origin,
				path: url.pathname,
				authorization: new Headers(init?.headers).get("authorization"),
			});
			return Response.json(PASSWORD_STATUS);
		}
		if (url.pathname === "/api/billing/subscription-status") {
			accountBackendReads.push({
				origin: url.origin,
				path: url.pathname,
				authorization: new Headers(init?.headers).get("authorization"),
			});
			return Response.json({
				status: "active",
				plan: "pro",
				interval: "month",
			});
		}
		if (url.pathname === "/api/sessions") {
			accountBackendReads.push({
				origin: url.origin,
				path: url.pathname,
				authorization: new Headers(init?.headers).get("authorization"),
			});
			return Response.json({ sessions: [] });
		}
		if (url.pathname === "/api/auth/accounts/switch" && method === "POST") {
			const body = accountSelectionObservation.parse(
				JSON.parse(String(init?.body))
			);
			actions.push({ body, path: url.pathname });
			activeUserId = body.userId;
			return Response.json({ success: true });
		}
		if (url.pathname === "/api/auth/accounts/remove" && method === "POST") {
			const body = accountSelectionObservation.parse(
				JSON.parse(String(init?.body))
			);
			actions.push({ body, path: url.pathname });
			const index = accounts.findIndex(
				(account) => account.userId === body.userId
			);
			if (index >= 0) {
				accounts.splice(index, 1);
			}
			if (activeUserId === body.userId) {
				activeUserId = accounts[0]?.userId ?? null;
			}
			return Response.json({ success: true });
		}
		if (url.pathname === "/api/auth/login" && method === "POST") {
			loginCount += 1;
			actions.push({
				body: appResponseValueSchema.parse(JSON.parse(String(init?.body))),
				path: url.pathname,
			});
			return Response.json({
				userCode: `CODE-${loginCount}`,
				verificationUri: null,
			});
		}
		if (url.pathname === "/api/auth/logout" && method === "POST") {
			actions.push({ body: null, path: url.pathname });
			activeUserId = null;
			return Response.json({ success: true });
		}
		return Response.json({});
	});
	setup = await testRender(<Harness />, { width: 100, height: 28 });
	const renderer = setup;
	const first = await waitFor(
		renderer,
		(frame) =>
			frame.includes("Accounts") &&
			frame.includes("Alpha One") &&
			frame.includes("Beta Two")
	);
	expect(first).toContain("alpha@example.test");
	expect(first).toMatch(/Password\s+Set/);
	expect(first).toMatch(/2FA\s+Disabled/);
	expect(first).toMatch(/Sessions\s+0 active/);
	expect(accountBackendReads).toEqual(
		[
			"/api/auth/get-session",
			"/api/user/password-status",
			"/api/billing/subscription-status",
			"/api/sessions",
			"/api/auth/get-session",
		].map((path) => ({
			origin: AUTH_BACKEND_URL,
			path,
			authorization: "Bearer alpha-token",
		}))
	);

	const readsBeforeRefresh = authStatusReads;
	await press(renderer, "r");
	await waitFor(renderer, () => authStatusReads > readsBeforeRefresh);

	await press(renderer, "down");
	await waitFor(
		renderer,
		(frame) => frame.includes("›") && frame.includes("Beta Two")
	);
	await press(renderer, "s");
	const switched = await waitFor(
		renderer,
		(frame) =>
			frame.includes("beta@example.test") &&
			frame.includes("Beta Two") &&
			accountBackendReads.some(
				(read) =>
					read.path === "/api/auth/get-session" &&
					read.authorization === "Bearer beta-token"
			)
	);
	expect(switched).toContain("active");
	const switchCountBeforeActiveNoop = actions.filter(
		(action) => action.path === "/api/auth/accounts/switch"
	).length;
	await press(renderer, "s");
	expect(
		actions.filter((action) => action.path === "/api/auth/accounts/switch")
	).toHaveLength(switchCountBeforeActiveNoop);
	await press(renderer, "x");
	await waitFor(
		renderer,
		(frame) => frame.includes("Alpha One") && !frame.includes("Beta Two")
	);
	expect(actions).toContainEqual({
		body: { userId: "beta" },
		path: "/api/auth/accounts/remove",
	});

	await press(renderer, "a");
	const adding = await waitFor(renderer, (frame) => frame.includes("CODE-1"));
	expect(adding).toContain("Signing in");
	await press(renderer, "L", true);
	const signedOut = await waitFor(renderer, (frame) =>
		frame.includes("Signed out")
	);
	expect(signedOut).not.toContain("Active account");
	await press(renderer, "l");
	const signingIn = await waitFor(renderer, (frame) =>
		frame.includes("CODE-2")
	);
	expect(signingIn).toContain("Signing in");

	expect(
		actions.filter((action) => action.path === "/api/auth/login")
	).toHaveLength(2);
	expect(actions.filter((action) => action.path === "/api/auth/login")).toEqual(
		[
			{ body: { backendUrl: AUTH_BACKEND_URL }, path: "/api/auth/login" },
			{ body: { backendUrl: AUTH_BACKEND_URL }, path: "/api/auth/login" },
		]
	);
	expect(actions).toContainEqual({
		body: { userId: "beta" },
		path: "/api/auth/accounts/switch",
	});
	expect(actions.some((action) => action.path === "/api/auth/logout")).toBe(
		true
	);
});

test("Account deactivation aborts security reads and reactivation reads only the active account", async () => {
	let changeActive: (active: boolean) => void = () => {};
	let holdSecurityRead = true;
	let sessionReads = 0;
	const securityRequests: Array<{ path: string; token: string | null }> = [];
	const pendingSignals: AbortSignal[] = [];
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/auth/status") {
			return Response.json(coreAuthStatus("active-account-token"));
		}
		if (url.pathname === "/api/auth/accounts") {
			return Response.json({
				accounts: [
					{
						userId: "alpha",
						name: "Alpha One",
						email: "alpha@example.test",
						active: true,
					},
				],
			});
		}
		if (url.pathname === "/api/auth/get-session") {
			sessionReads += 1;
			if (sessionReads === 2 && holdSecurityRead && init?.signal) {
				const signal = init.signal;
				pendingSignals.push(signal);
				return new Promise<Response>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")), {
						once: true,
					});
				});
			}
			return Response.json(
				betterAuthSession({
					id: "alpha",
					name: "Alpha One",
					email: "alpha@example.test",
					emailVerified: true,
					twoFactorEnabled: false,
				})
			);
		}
		if (
			url.pathname === "/api/user/email-change-status" ||
			url.pathname.startsWith("/api/step-up/")
		) {
			securityRequests.push({
				path: url.pathname,
				token: new Headers(init?.headers).get("authorization"),
			});
			return Response.json({ hasActive: false });
		}
		if (url.pathname === "/api/user/password-status") {
			return Response.json(PASSWORD_STATUS);
		}
		if (url.pathname === "/api/sessions") {
			return Response.json({ sessions: [] });
		}
		return Response.json({});
	});
	function LifecycleHarness() {
		const [active, setActive] = useState(false);
		changeActive = setActive;
		return (
			<ThemeProvider reducedMotion>
				<CoreProvider initial={LOCAL_TARGET}>
					<ToastProvider>
						<AccountTab active={active} />
						<ToastHost />
					</ToastProvider>
				</CoreProvider>
			</ThemeProvider>
		);
	}
	setup = await testRender(<LifecycleHarness />, { width: 140, height: 48 });
	const renderer = setup;
	await renderer.flush({ maxPasses: 12 });
	expect(sessionReads).toBe(0);
	await act(async () => changeActive(true));
	await waitFor(renderer, () => pendingSignals.length === 1);
	expect(pendingSignals[0]?.aborted).toBe(false);
	await act(async () => changeActive(false));
	expect(pendingSignals[0]?.aborted).toBe(true);
	const readsAtClose = sessionReads;
	const requestsAtClose = securityRequests.length;
	await press(renderer, "w");
	await renderer.flush({ maxPasses: 12 });
	expect(sessionReads).toBe(readsAtClose);
	expect(securityRequests).toHaveLength(requestsAtClose);
	holdSecurityRead = false;
	await act(async () => changeActive(true));
	await waitFor(renderer, () => sessionReads >= readsAtClose + 3);
	expect(
		securityRequests.filter(
			(request) => request.path === "/api/user/email-change-status"
		)
	).toHaveLength(3);
	expect(
		securityRequests.every(
			(request) => request.token === "Bearer active-account-token"
		)
	).toBe(true);
	expect(
		securityRequests.some((request) => request.path.startsWith("/api/step-up/"))
	).toBe(false);
});

async function waitForPolledFrame(
	renderer: Awaited<ReturnType<typeof testRender>>,
	predicate: (frame: string) => boolean
): Promise<string> {
	const deadline = Date.now() + 5000;
	let frame = renderer.captureCharFrame();
	while (!predicate(frame) && Date.now() < deadline) {
		await act(async () => {
			await Bun.sleep(50);
		});
		await renderer.renderOnce();
		frame = renderer.captureCharFrame();
	}
	if (!predicate(frame)) {
		throw new Error(`Account render did not match: ${frame}`);
	}
	return frame;
}

test("A denied add-account flow is reported as denied, not as a sign-in", async () => {
	let flowStarted = false;
	let statusReadsAfterStart = 0;
	installResponse(async (input, init) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		if (url.pathname === "/api/auth/status") {
			if (!flowStarted) {
				return Response.json({
					...coreAuthStatus("alpha-token"),
					lastFlow: null,
				});
			}
			statusReadsAfterStart += 1;
			if (statusReadsAfterStart === 1) {
				return Response.json({
					...coreAuthStatus("alpha-token"),
					authenticated: false,
					pending: true,
					userCode: "CODE-ADD",
					lastFlow: null,
				});
			}
			// Core settled the denied flow back onto the still-active account A.
			return Response.json({
				...coreAuthStatus("alpha-token"),
				lastFlow: {
					userCode: "CODE-ADD",
					result: "failed",
					error: "access_denied",
				},
			});
		}
		if (url.pathname === "/api/auth/accounts") {
			return Response.json({
				accounts: [
					{
						userId: "alpha",
						name: "Alpha One",
						email: "alpha@example.test",
						active: true,
					},
				],
				activeUserId: "alpha",
			});
		}
		if (url.pathname === "/api/auth/get-session") {
			return Response.json(
				betterAuthSession({
					id: "alpha",
					name: "Alpha One",
					email: "alpha@example.test",
					emailVerified: true,
					twoFactorEnabled: false,
				})
			);
		}
		if (url.pathname === "/api/user/password-status") {
			return Response.json(PASSWORD_STATUS);
		}
		if (url.pathname === "/api/sessions") {
			return Response.json({ sessions: [] });
		}
		if (url.pathname === "/api/auth/login" && method === "POST") {
			flowStarted = true;
			return Response.json({ userCode: "CODE-ADD", verificationUri: null });
		}
		return Response.json({});
	});
	setup = await testRender(<Harness />, { width: 100, height: 28 });
	const renderer = setup;
	await waitFor(renderer, (frame) => frame.includes("Alpha One"));
	await press(renderer, "a");
	await waitFor(renderer, (frame) => frame.includes("CODE-ADD"));
	const settled = await waitForPolledFrame(renderer, (frame) =>
		frame.includes("Sign-in was denied")
	);
	expect(statusReadsAfterStart).toBe(2);
	expect(settled).not.toContain("Signed in");
}, 10_000);

describe("pollOnce reads the outcome of its own device flow", () => {
	function statusResponse(status: Record<string, unknown>): void {
		installResponse(async () =>
			Response.json({ ...coreAuthStatus("alpha-token"), ...status })
		);
	}

	test("a failed flow for this code ends the poll even though Core is authenticated", async () => {
		statusResponse({
			lastFlow: {
				userCode: "CODE-1",
				result: "failed",
				error: "device_code_expired",
			},
		});
		expect(await pollOnce(LOCAL_TARGET, "CODE-1")).toEqual({
			failed: "device_code_expired",
		});
	});

	test("a succeeded flow for this code signs in", async () => {
		statusResponse({
			token: "beta-token",
			lastFlow: { userCode: "CODE-1", result: "succeeded", error: null },
		});
		expect(await pollOnce(LOCAL_TARGET, "CODE-1")).toBe(true);
	});

	test("a pending flow keeps polling", async () => {
		statusResponse({
			authenticated: false,
			pending: true,
			userCode: "CODE-1",
			lastFlow: null,
		});
		expect(await pollOnce(LOCAL_TARGET, "CODE-1")).toBe(false);
	});

	test("another flow's outcome is not this flow's sign-in", async () => {
		statusResponse({
			lastFlow: { userCode: "CODE-0", result: "succeeded", error: null },
		});
		expect(await pollOnce(LOCAL_TARGET, "CODE-1")).toEqual({
			failed: "cancelled",
		});
	});

	test("a Core without lastFlow falls back to the settled state", async () => {
		statusResponse({});
		expect(await pollOnce(LOCAL_TARGET, "CODE-1")).toBe(true);
	});
});
