import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { RyuFetch } from "@ryuhq/core-client/client.ts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { MfaEnrollmentGateProps } from "./MfaEnrollmentGate.tsx";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);

const { MfaEnrollmentGate } = await import("./MfaEnrollmentGate.tsx");
const { mfaEnrollmentClearKeyForUser } = await import(
	"../lib/mfa-enrollment-gate.ts"
);

const CONTROL_PLANE = "https://api.example.test";
const WEB_ORIGIN = "https://web.example.test/";
const SETUP_URL = "https://web.example.test/settings/setup-2fa";
const ENROLLMENT_TITLE = "Set up two-factor authentication";

interface StatusRead {
	authorization: string | null;
	signal: AbortSignal | null;
	url: string;
}

type Reply = (signal: AbortSignal | null) => Promise<Response>;

function status(required: boolean): Reply {
	return () =>
		Promise.resolve(
			new Response(JSON.stringify({ required }), {
				headers: { "content-type": "application/json" },
				status: 200,
			})
		);
}

const serverError: Reply = () =>
	Promise.resolve(new Response("unavailable", { status: 503 }));

/** A reply that waits for `release`, or rejects once the read is aborted. */
interface HeldReply {
	release: (next: Reply) => void;
	reply: Reply;
}

function heldReply(): HeldReply {
	let release: (next: Reply) => void = () => undefined;
	const reply: Reply = (signal) =>
		new Promise<Response>((resolve, reject) => {
			release = (next) => {
				next(signal).then(resolve, reject);
			};
			signal?.addEventListener("abort", () =>
				reject(new DOMException("aborted", "AbortError"))
			);
		});
	return { release: (next) => release(next), reply };
}

/** The control plane's status endpoint, answering with whatever `reply` says. */
function statusServer(initial: Reply) {
	const reads: StatusRead[] = [];
	let reply = initial;
	const fetch: RyuFetch = (input, init) => {
		const signal = init?.signal ?? null;
		reads.push({
			authorization: new Headers(init?.headers).get("Authorization"),
			signal,
			url: String(input),
		});
		return reply(signal);
	};
	return {
		fetch,
		reads,
		respond(next: Reply) {
			reply = next;
		},
	};
}

function buttonNamed(name: string): HTMLButtonElement {
	const found = Array.from(document.querySelectorAll("button")).find(
		(element) => element.textContent?.trim() === name
	);
	if (!found) {
		throw new Error(`Missing button ${name}`);
	}
	return found;
}

function heading(): string | null {
	return document.querySelector("h1")?.textContent?.trim() ?? null;
}

function appShown(): boolean {
	return document.querySelector("[data-testid='app']") !== null;
}

function loadingShown(): boolean {
	return document.querySelector("[data-testid='loading']") !== null;
}

/** Let pending reads resolve and React commit what they set. */
async function settle() {
	for (let round = 0; round < 3; round += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}
}

async function click(element: Element) {
	await act(async () => {
		element.dispatchEvent(
			new MouseEvent("click", { bubbles: true, button: 0 })
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	await settle();
}

describe("MfaEnrollmentGate", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let opened: string[];

	beforeEach(() => {
		localStorage.clear();
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		opened = [];
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		document.body.replaceChildren();
		localStorage.clear();
	});

	async function render(
		props: Partial<MfaEnrollmentGateProps> & { fetch: RyuFetch }
	) {
		await act(async () => {
			root.render(
				<MfaEnrollmentGate
					accountEmail="ada@example.test"
					accountId="user-a"
					controlPlaneUrl={CONTROL_PLANE}
					enabled
					loading={<p data-testid="loading">Loading</p>}
					openUrl={(url) => {
						opened.push(url);
					}}
					token="token-a"
					webOrigin={WEB_ORIGIN}
					{...props}
				>
					<main data-testid="app">The app</main>
				</MfaEnrollmentGate>
			);
		});
		await settle();
	}

	it("shows the enrollment screen for a required account and opens the website's setup page", async () => {
		const server = statusServer(status(true));
		await render({ fetch: server.fetch });

		expect(server.reads).toHaveLength(1);
		expect(server.reads[0]?.url).toBe(
			`${CONTROL_PLANE}/api/auth/mfa-enrollment/status`
		);
		expect(server.reads[0]?.authorization).toBe("Bearer token-a");
		expect(appShown()).toBe(false);
		expect(heading()).toBe(ENROLLMENT_TITLE);
		expect(document.body.textContent).toContain("passkey");
		expect(document.body.textContent).toContain("authenticator app");
		expect(document.body.textContent).toContain("ada@example.test");
		// The waitlist screen's way out is kept.
		expect(buttonNamed("Sign out").disabled).toBe(false);

		await click(buttonNamed("Open setup in browser"));
		expect(opened).toEqual([SETUP_URL]);
		expect(localStorage.getItem(mfaEnrollmentClearKeyForUser("user-a"))).toBe(
			null
		);
	});

	it("opens the app for a clear account and remembers it", async () => {
		const server = statusServer(status(false));
		await render({ fetch: server.fetch });

		expect(server.reads).toHaveLength(1);
		expect(appShown()).toBe(true);
		expect(heading()).toBe(null);
		expect(localStorage.getItem(mfaEnrollmentClearKeyForUser("user-a"))).toBe(
			"1"
		);
	});

	it("opens the app when the status cannot be read", async () => {
		const server = statusServer(serverError);
		await render({ fetch: server.fetch });
		expect(server.reads).toHaveLength(1);
		expect(appShown()).toBe(true);
		expect(heading()).toBe(null);

		await act(async () => root.unmount());
		root = createRoot(container);
		const offline = statusServer(() =>
			Promise.reject(new TypeError("Failed to fetch"))
		);
		await render({ fetch: offline.fetch });
		expect(offline.reads).toHaveLength(1);
		expect(appShown()).toBe(true);
	});

	it("never reads the status for anonymous or signed-out use", async () => {
		const server = statusServer(status(true));
		await render({ enabled: false, fetch: server.fetch });
		expect(server.reads).toHaveLength(0);
		expect(appShown()).toBe(true);
	});

	it("holds the app back during the first read, unless this account was clear before", async () => {
		const held = heldReply();
		const server = statusServer(held.reply);
		await render({ fetch: server.fetch });
		expect(loadingShown()).toBe(true);
		expect(appShown()).toBe(false);

		await act(async () => held.release(status(true)));
		await settle();
		expect(loadingShown()).toBe(false);
		expect(heading()).toBe(ENROLLMENT_TITLE);

		await act(async () => root.unmount());
		root = createRoot(container);
		localStorage.setItem(mfaEnrollmentClearKeyForUser("user-a"), "1");
		const cached = heldReply();
		const returning = statusServer(cached.reply);
		await render({ fetch: returning.fetch });
		expect(returning.reads).toHaveLength(1);
		expect(appShown()).toBe(true);
		// A cached answer is only a head start: the live read still wins.
		await act(async () => cached.release(status(true)));
		await settle();
		expect(appShown()).toBe(false);
		expect(heading()).toBe(ENROLLMENT_TITLE);
	});

	it("check again lets an account that just enrolled into the app", async () => {
		const server = statusServer(status(true));
		await render({ fetch: server.fetch });
		expect(heading()).toBe(ENROLLMENT_TITLE);

		// Still not enrolled: the screen stays and says so.
		await click(buttonNamed("Check again"));
		expect(server.reads).toHaveLength(2);
		expect(heading()).toBe(ENROLLMENT_TITLE);
		expect(document.querySelector("[role='status']")?.textContent).toContain(
			"Still not set up"
		);

		server.respond(status(false));
		await click(buttonNamed("Check again"));
		expect(server.reads).toHaveLength(3);
		expect(appShown()).toBe(true);
		expect(heading()).toBe(null);
	});

	it("re-reads the status when the window regains focus", async () => {
		const server = statusServer(status(true));
		await render({ fetch: server.fetch });
		expect(heading()).toBe(ENROLLMENT_TITLE);

		server.respond(status(false));
		await act(async () => {
			window.dispatchEvent(new Event("focus"));
		});
		await settle();
		expect(server.reads).toHaveLength(2);
		expect(appShown()).toBe(true);

		// Clear stops the re-reads, like the waitlist gate after approval.
		await act(async () => {
			window.dispatchEvent(new Event("focus"));
		});
		await settle();
		expect(server.reads).toHaveLength(2);
	});

	it("re-reads the status for a different account and never reuses the last answer", async () => {
		const server = statusServer(status(false));
		await render({ fetch: server.fetch });
		expect(appShown()).toBe(true);

		const held = heldReply();
		server.respond(held.reply);
		await render({
			accountEmail: "grace@example.test",
			accountId: "user-b",
			fetch: server.fetch,
			token: "token-b",
		});
		expect(server.reads).toHaveLength(2);
		expect(server.reads[1]?.authorization).toBe("Bearer token-b");
		// Account A's clear answer must not let account B in while B is read.
		expect(appShown()).toBe(false);
		expect(loadingShown()).toBe(true);

		await act(async () => held.release(status(true)));
		await settle();
		expect(heading()).toBe(ENROLLMENT_TITLE);
		expect(document.body.textContent).toContain("grace@example.test");
	});

	it("re-reads the status when the session token changes", async () => {
		const server = statusServer(status(true));
		await render({ fetch: server.fetch });
		expect(heading()).toBe(ENROLLMENT_TITLE);

		server.respond(status(false));
		await render({ fetch: server.fetch, token: "token-a-renewed" });
		expect(server.reads).toHaveLength(2);
		expect(server.reads[1]?.authorization).toBe("Bearer token-a-renewed");
		expect(appShown()).toBe(true);
	});

	it("aborts an in-flight read on unmount and on account change", async () => {
		const first = heldReply();
		const server = statusServer(first.reply);
		await render({ fetch: server.fetch });
		const firstSignal = server.reads[0]?.signal;
		expect(firstSignal?.aborted).toBe(false);

		server.respond(heldReply().reply);
		await render({
			accountId: "user-b",
			fetch: server.fetch,
			token: "token-b",
		});
		expect(firstSignal?.aborted).toBe(true);

		const secondSignal = server.reads[1]?.signal;
		expect(secondSignal?.aborted).toBe(false);
		await act(async () => root.unmount());
		expect(secondSignal?.aborted).toBe(true);
		root = createRoot(container);
	});
});
