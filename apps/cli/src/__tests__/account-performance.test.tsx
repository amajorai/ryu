/* @jsxImportSource @opentui/react */

import { expect, test } from "bun:test";
import { KeyEvent } from "@opentui/core";
import { act } from "react";
import { ThemeProvider } from "../../components/ui/theme-provider.tsx";
import { startAccountPolling } from "../core/account-polling.ts";
import { CoreProvider } from "../core/CoreContext.tsx";
import { AccountTab } from "../tabs/account.tsx";
import { ToastProvider } from "../ui/toast.tsx";
import { testRender } from "./cli-test-render.ts";

async function until(predicate: () => boolean) {
	const deadline = Date.now() + 3000;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error("Account fixture timed out");
		}
		await Bun.sleep(5);
	}
}
test("stopping a slow observer aborts its probe and ignores a late success", async () => {
	let calls = 0;
	let signal!: AbortSignal;
	let release!: (value: boolean) => void;
	const results: boolean[] = [];
	const stop = startAccountPolling(
		(nextSignal) => {
			calls++;
			signal = nextSignal;
			return new Promise((resolve) => {
				release = resolve;
			});
		},
		(value) => results.push(value),
		{ intervalMs: 5, timeoutMs: 1000 }
	);
	try {
		await until(() => calls === 1);
		await Bun.sleep(25);
		expect(calls).toBe(1);
		stop();
		expect(signal.aborted).toBe(true);
		release(true);
		await Bun.sleep(20);
		expect(results).toEqual([]);
	} finally {
		stop();
	}
});
test("deadline aborts a stalled probe and reports timeout once", async () => {
	let signal!: AbortSignal;
	const results: boolean[] = [];
	const stop = startAccountPolling(
		(nextSignal) => {
			signal = nextSignal;
			return new Promise(() => undefined);
		},
		(value) => results.push(value),
		{ intervalMs: 1, timeoutMs: 30 }
	);
	try {
		await until(() => results.length > 0);
		expect(signal.aborted).toBe(true);
		expect(results).toEqual([false]);
	} finally {
		stop();
	}
});
for (const phase of ["startup", "status"] as const) {
	test(`closing Account cancels ${phase} without another poll`, async () => {
		let signInStarted = false;
		let statusCalls = 0;
		let cancelled = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				const path = new URL(req.url).pathname;
				if (path === "/api/auth/login") {
					signInStarted = true;
					if (phase === "startup") {
						return new Response(
							new ReadableStream({
								cancel() {
									cancelled++;
								},
							}),
							{ headers: { "Content-Type": "application/json" } }
						);
					}
					return Response.json({ userCode: "FIXTURE" });
				}
				if (path === "/api/auth/status") {
					statusCalls++;
					if (signInStarted) {
						return new Response(
							new ReadableStream({
								cancel() {
									cancelled++;
								},
							}),
							{ headers: { "Content-Type": "application/json" } }
						);
					}
					return Response.json({ authenticated: false });
				}
				return Response.json({ accounts: [] });
			},
		});
		const setup = await testRender(
			<ThemeProvider reducedMotion>
				<CoreProvider initial={{ url: server.url.toString(), token: null }}>
					<ToastProvider>
						<AccountTab active />
					</ToastProvider>
				</CoreProvider>
			</ThemeProvider>,
			{ width: 100, height: 30 }
		);
		let closed = false;
		try {
			await act(async () => {
				await until(() => statusCalls === 1);
				await Bun.sleep(30);
			});
			await act(async () => {
				setup.renderer.keyInput.emit(
					"keypress",
					new KeyEvent({
						name: "l",
						sequence: "l",
						shift: false,
						ctrl: false,
						meta: false,
						option: false,
						eventType: "press",
						repeated: false,
						number: false,
						raw: "l",
						source: "raw",
					})
				);
			});
			await act(async () => {
				await until(() =>
					phase === "status" ? statusCalls === 2 : signInStarted
				);
			});
			await act(async () => {
				setup.renderer.destroy();
			});
			closed = true;
			await until(() => cancelled === 1);
			await Bun.sleep(1600);
			expect(statusCalls).toBe(phase === "status" ? 2 : 1);
		} finally {
			if (!closed) {
				await act(async () => {
					setup.renderer.destroy();
				});
			}
			server.stop(true);
		}
	}, 10_000);
}

test("successful observation stops after the first authenticated result", async () => {
	let calls = 0;
	const results: boolean[] = [];
	const stop = startAccountPolling(
		async () => ++calls === 2,
		(value) => results.push(value),
		{ intervalMs: 5, timeoutMs: 200 }
	);
	try {
		await until(() => results.length === 1);
		await Bun.sleep(30);
		expect(results).toEqual([true]);
		expect(calls).toBe(2);
	} finally {
		stop();
	}
});
