/* @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { act, useState } from "react";
import { ThemeProvider } from "../../components/ui/theme-provider.tsx";
import { CoreProvider } from "../core/CoreContext.tsx";
import { AppsTab } from "../tabs/apps.tsx";
import { ToastProvider } from "../ui/toast.tsx";
import { testRender } from "./cli-test-render.ts";

async function until(predicate: () => boolean) {
	const deadline = Date.now() + 3000;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error("Catalog fixture timed out");
		}
		await Bun.sleep(10);
	}
}
test("installation polls share a pending read, close cancels it, and completed installs stop polling", async () => {
	let requests = 0;
	let cancelled = 0;
	let complete = false;
	let setActive!: (active: boolean) => void;
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch() {
			requests++;
			if (requests > 1 && !complete) {
				return new Response(
					new ReadableStream({
						cancel() {
							cancelled++;
						},
					}),
					{ headers: { "Content-Type": "application/json" } }
				);
			}
			return Response.json({
				sidecars: [
					{
						name: "ollama",
						category: "provider",
						install_state: complete ? "installed" : "installing",
						installed_version: complete ? "1.0" : null,
						latest_version: "1.0",
					},
				],
			});
		},
	});
	function Harness() {
		const [active, update] = useState(true);
		setActive = update;
		return (
			<ThemeProvider reducedMotion>
				<CoreProvider initial={{ url: server.url.toString(), token: null }}>
					<ToastProvider>
						<AppsTab active={active} />
					</ToastProvider>
				</CoreProvider>
			</ThemeProvider>
		);
	}
	const setup = await testRender(<Harness />, { width: 100, height: 25 });
	try {
		await act(async () => {
			await until(() => requests === 1);
			await Bun.sleep(30);
		});
		await act(async () => {
			await until(() => requests === 2);
			await Bun.sleep(4200);
		});
		expect(requests).toBe(2);
		await act(async () => {
			setActive(false);
		});
		await until(() => cancelled === 1);
		complete = true;
		await act(async () => {
			setActive(true);
		});
		await act(async () => {
			await until(() => requests === 3);
			await Bun.sleep(30);
		});
		await setup.renderOnce();
		await act(async () => {
			await Bun.sleep(2100);
		});
		expect(requests).toBe(3);
		await setup.renderOnce();
		const frame = setup.captureCharFrame();
		expect(frame).toContain("ollama");
		expect(frame).toContain("installed");
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
		server.stop(true);
	}
}, 18_000);
