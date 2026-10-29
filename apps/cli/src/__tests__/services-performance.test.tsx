/* @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { KeyEvent } from "@opentui/core";
import { act, useState } from "react";
import { ThemeProvider } from "../../components/ui/theme-provider.tsx";
import { CoreProvider } from "../core/CoreContext.tsx";
import { loadServices } from "../core/services-snapshot.ts";
import { ServicesTab } from "../tabs/services.tsx";
import { ToastProvider } from "../ui/toast.tsx";
import { testRender } from "./cli-test-render.ts";

const replies = new Map(
	Object.entries({
		"/api/sidecar/status": { sidecars: [{ name: "ollama", running: true }] },
		"/api/setup/list": { installed: ["ollama"] },
		"/api/setup/status": { states: {} },
	})
);
async function until(predicate: () => boolean) {
	const deadline = Date.now() + 3000;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error("Services fixture timed out");
		}
		await Bun.sleep(10);
	}
}
test("partial failures retain installed services and aborted loads reject", async () => {
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			const path = new URL(req.url).pathname;
			return path === "/api/setup/list"
				? Response.json(replies.get(path))
				: new Response("offline", { status: 503 });
		},
	});
	try {
		const target = { url: server.url.toString(), token: null };
		const result = await loadServices(target);
		expect(result.offline).toBe(false);
		expect([...result.installed]).toEqual(["ollama"]);
		expect(result.running.size).toBe(0);
		const controller = new AbortController();
		controller.abort();
		await expect(loadServices(target, controller.signal)).rejects.toThrow();
	} finally {
		server.stop(true);
	}
});

test("Services parallelizes probes, skips busy poll ticks and cancels when inactive", async () => {
	let hold = true;
	let requests = 0;
	let cancelled = 0;
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			requests++;
			if (!hold) {
				return Response.json(replies.get(new URL(req.url).pathname));
			}
			return new Response(
				new ReadableStream({
					cancel() {
						cancelled++;
					},
				}),
				{ headers: { "Content-Type": "application/json" } }
			);
		},
	});
	let setActive!: (active: boolean) => void;
	function Harness() {
		const [active, update] = useState(true);
		setActive = update;
		return (
			<ThemeProvider reducedMotion>
				<CoreProvider initial={{ url: server.url.toString(), token: null }}>
					<ToastProvider>
						<ServicesTab active={active} />
					</ToastProvider>
				</CoreProvider>
			</ThemeProvider>
		);
	}
	const setup = await testRender(<Harness />, { width: 110, height: 30 });
	try {
		await setup.renderOnce();
		await act(async () => {
			await until(() => requests === 3);
			await Bun.sleep(5100);
		});
		expect(requests).toBe(3);
		await act(async () => {
			setActive(false);
		});
		await setup.renderOnce();
		await act(async () => {
			await until(() => cancelled === 3);
		});
		hold = false;
		await act(async () => {
			setActive(true);
		});
		await setup.renderOnce();
		await act(async () => {
			await until(() => requests === 6);
			await Bun.sleep(30);
		});
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		expect(frame).toContain("Services");
		expect(frame).toContain("ollama");
		expect(frame).toContain("running");
		await writeFile(
			resolve(
				import.meta.dirname,
				"../../../../docs/proof/performance-sweep/cli-services-frame.txt"
			),
			`${frame
				.split("\n")
				.map((line) => line.trimEnd())
				.join("\n")
				.trimEnd()}\n`
		);
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
		server.stop(true);
	}
}, 15_000);

test("an action finishing after close does not restart status reads", async () => {
	let reads = 0;
	let writes = 0;
	let complete!: (response: Response) => void;
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			if (req.method === "POST") {
				writes++;
				return new Promise<Response>((resolve) => {
					complete = resolve;
				});
			}
			reads++;
			return Response.json(replies.get(new URL(req.url).pathname));
		},
	});
	const setup = await testRender(
		<ThemeProvider reducedMotion>
			<CoreProvider initial={{ url: server.url.toString(), token: null }}>
				<ToastProvider>
					<ServicesTab active />
				</ToastProvider>
			</CoreProvider>
		</ThemeProvider>,
		{ width: 110, height: 30 }
	);
	let closed = false;
	try {
		await act(async () => {
			await until(() => reads === 3);
			await Bun.sleep(30);
		});
		await setup.renderOnce();
		await act(async () => {
			setup.renderer.keyInput.emit(
				"keypress",
				new KeyEvent({
					name: "a",
					sequence: "A",
					shift: true,
					ctrl: false,
					meta: false,
					option: false,
					eventType: "press",
					repeated: false,
					number: false,
					raw: "A",
					source: "raw",
				})
			);
		});
		await setup.renderOnce();
		// Start-all is gated by the confirm prompt; y sends it.
		await act(async () => {
			setup.renderer.keyInput.emit(
				"keypress",
				new KeyEvent({
					name: "y",
					sequence: "y",
					shift: false,
					ctrl: false,
					meta: false,
					option: false,
					eventType: "press",
					repeated: false,
					number: false,
					raw: "y",
					source: "raw",
				})
			);
		});
		await until(() => writes === 1);
		await act(async () => {
			setup.renderer.destroy();
		});
		closed = true;
		await act(async () => {
			complete(Response.json({ ok: true }));
			await Bun.sleep(50);
		});
		expect(reads).toBe(3);
	} finally {
		if (!closed) {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
		server.stop(true);
	}
});
