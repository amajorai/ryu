// Every desktop window runs this listener against the auth service. It must
// back off with jitter instead of retrying in lockstep every 2s, park a refused
// session for minutes, and send the CURRENT session token on each reconnect.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { afterAll, afterEach, beforeEach, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const TOKEN_KEY = "ryu_session_token";
const delays: number[] = [];
let onDelay: (count: number) => void = () => undefined;
mock.module("@/lib/auth-client.ts", () => ({
	BACKEND_URL: "http://auth.test",
	getActiveUserId: () => "user-1",
	TOKEN_KEY,
	useSession: () => ({ data: { user: { id: "user-1" } } }),
	getActiveToken: () => globalThis.localStorage?.getItem(TOKEN_KEY) ?? null,
}));
mock.module("@/src/lib/abortable-delay.ts", () => ({
	abortableDelay: (ms: number, signal: AbortSignal) => {
		delays.push(ms);
		onDelay(delays.length);
		if (delays.length < 2) {
			return Promise.resolve();
		}
		// Park the loop until unmount so each case observes two reconnects.
		return new Promise<void>((resolve) => {
			signal.addEventListener("abort", () => resolve(), { once: true });
		});
	},
}));

const { LoginApprovalEvents } = await import("./useLoginApprovalEvents.tsx");

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const realFetch = globalThis.fetch;
let status = 401;
let authorizations: Array<string | null> = [];
let root: Root;

async function mount(): Promise<void> {
	await act(async () => root.render(<LoginApprovalEvents />));
}

async function untilDelays(count: number): Promise<void> {
	const deadline = Date.now() + 2000;
	while (delays.length < count) {
		if (Date.now() >= deadline) {
			throw new Error(`listener did not reconnect: ${delays.join(",")}`);
		}
		await act(async () => {
			await Bun.sleep(2);
		});
	}
}

beforeEach(() => {
	delays.length = 0;
	authorizations = [];
	onDelay = () => undefined;
	localStorage.setItem(TOKEN_KEY, "token-1");
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			authorizations.push(new Headers(init?.headers).get("authorization"));
			return Promise.resolve(
				String(input).endsWith("/pending")
					? Response.json({ error: "refused" }, { status })
					: new Response(null, { status: 404 })
			);
		},
		{ preconnect: realFetch.preconnect }
	);
	root = createRoot(document.createElement("div"));
});

afterEach(async () => {
	await act(async () => root.unmount());
});

afterAll(() => {
	globalThis.fetch = realFetch;
	localStorage.removeItem(TOKEN_KEY);
});

it("parks a refused session and reconnects with the newly stored token", async () => {
	status = 401;
	// The user signs in again as the same account while the listener waits.
	onDelay = (count) => {
		if (count === 1) {
			localStorage.setItem(TOKEN_KEY, "token-2");
		}
	};
	await mount();
	await untilDelays(2);
	expect(delays).toEqual([300_000, 300_000]);
	expect(authorizations).toEqual(["Bearer token-1", "Bearer token-2"]);
});

it("backs a failing auth service off with jitter instead of a fixed 2s", async () => {
	status = 503;
	await mount();
	await untilDelays(2);
	expect(delays[0]).toBeGreaterThanOrEqual(500);
	expect(delays[0]).toBeLessThanOrEqual(1000);
	expect(delays[1]).toBeGreaterThanOrEqual(1000);
	expect(delays[1]).toBeLessThanOrEqual(2000);
});
