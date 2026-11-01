/* @jsxImportSource @opentui/react */

// Signing in from the Account tab hands the approval link to the browser
// with the CLI surface declared, so the session Core creates counts as a CLI
// device rather than a self-hosted one.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { KeyEvent } from "@opentui/core";
import { act } from "react";
import { ThemeProvider } from "../../components/ui/theme-provider.tsx";
import { AUTH_BACKEND_URL } from "../core/authBackend.ts";
import { CoreProvider } from "../core/CoreContext.tsx";
import { ToastHost, ToastProvider } from "../ui/toast.tsx";
import { testRender } from "./cli-test-render.ts";

// Handing the link to the system browser is the one effect a frame cannot
// show, so the opener is observed instead of spawning a real browser.
const openedUrls: string[] = [];
mock.module("../core/openBrowser.ts", () => ({
	openBrowser: (url: string | null) => {
		if (url) {
			openedUrls.push(url);
		}
	},
}));
const { AccountTab } = await import("../tabs/account.tsx");

const LOCAL_TARGET = { url: "http://127.0.0.1:7980", token: null };
const APPROVAL_LINK = "https://auth.example.test/device?user_code=CODE-CLI";
const realFetch = globalThis.fetch;
const originalAuthUrl = process.env.RYU_AUTH_URL;
let setup: Awaited<ReturnType<typeof testRender>> | null = null;

beforeEach(() => {
	process.env.RYU_AUTH_URL = AUTH_BACKEND_URL;
	openedUrls.length = 0;
});

afterEach(async () => {
	if (originalAuthUrl === undefined) {
		delete process.env.RYU_AUTH_URL;
	} else {
		process.env.RYU_AUTH_URL = originalAuthUrl;
	}
	globalThis.fetch = realFetch;
	await act(async () => {
		setup?.renderer.destroy();
		await Promise.resolve();
	});
	setup = null;
});

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

async function press(
	renderer: Awaited<ReturnType<typeof testRender>>,
	name: string
): Promise<void> {
	await act(async () => {
		renderer.renderer.keyInput.emit(
			"keypress",
			new KeyEvent({
				name,
				sequence: name,
				shift: false,
				ctrl: false,
				meta: false,
				option: false,
				eventType: "press",
				repeated: false,
				number: false,
				raw: name,
				source: "raw",
			})
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await renderer.renderOnce();
	});
}

test("sign-in opens the approval link with the CLI surface declared", async () => {
	globalThis.fetch = Object.assign(
		(input: Parameters<typeof realFetch>[0], init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.pathname === "/api/auth/status") {
				return Promise.resolve(
					Response.json({
						authenticated: false,
						pending: false,
						token: null,
						userCode: null,
						verificationUri: null,
					})
				);
			}
			if (url.pathname === "/api/auth/accounts") {
				return Promise.resolve(
					Response.json({ accounts: [], activeUserId: null })
				);
			}
			if (url.pathname === "/api/auth/login" && init?.method === "POST") {
				return Promise.resolve(
					Response.json({
						userCode: "CODE-CLI",
						verificationUri: "https://auth.example.test/device",
						verificationUriComplete: APPROVAL_LINK,
					})
				);
			}
			return Promise.resolve(Response.json({}));
		},
		{ preconnect: realFetch.preconnect }
	);
	setup = await testRender(
		<ThemeProvider reducedMotion>
			<CoreProvider initial={LOCAL_TARGET}>
				<ToastProvider>
					<AccountTab active />
					<ToastHost />
				</ToastProvider>
			</CoreProvider>
		</ThemeProvider>,
		{ width: 120, height: 28 }
	);
	const renderer = setup;
	await waitFor(renderer, (frame) => frame.includes("Not signed in"));
	await press(renderer, "l");
	const signingIn = await waitFor(renderer, (frame) =>
		frame.includes("CODE-CLI")
	);
	expect(openedUrls).toEqual([`${APPROVAL_LINK}&surface=cli`]);
	expect(signingIn).toContain("surface=cli");
}, 10_000);
