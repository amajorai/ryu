/* @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { KeyEvent } from "@opentui/core";
import { act } from "react";
import { ThemeProvider } from "../../components/ui/theme-provider.tsx";
import { CoreProvider, useCore } from "../core/CoreContext.tsx";
import { ToastProvider } from "../ui/toast.tsx";
import { resolveSurface } from "../workspace/router.ts";
import {
	useWorkspace,
	WorkspaceProvider,
} from "../workspace/WorkspaceContext.tsx";
import { testRender } from "./cli-test-render.ts";

async function until(predicate: () => boolean) {
	const deadline = Date.now() + 3000;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error("Workflow fixture timed out");
		}
		await Bun.sleep(10);
	}
}
const run = (id: string) => ({
	run: {
		run_id: id,
		workflow_id: "fixture",
		status: "running",
		created_at: "",
		updated_at: "",
	},
});
test("run polls stay single and Escape cannot be undone by a late poll or run-start response", async () => {
	let starts = 0;
	let polls = 0;
	let cancelled = 0;
	let switchedReads = 0;
	let switchTarget!: () => void;
	let release!: (response: Response) => void;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const path = new URL(req.url).pathname;
			if (path === "/other/workflows") {
				switchedReads++;
				return new Response("offline", { status: 503 });
			}
			if (path === "/workflows") {
				return Response.json({
					workflows: [{ id: "fixture", name: "Fixture flow", nodes: [] }],
				});
			}
			if (req.method === "POST") {
				starts++;
				if (starts === 2) {
					return new Promise<Response>((resolve) => {
						release = resolve;
					});
				}
				return Response.json(run("run-1"));
			}
			polls++;
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
	function View() {
		const { focusedPaneId } = useWorkspace();
		const { setTarget } = useCore();
		switchTarget = () => setTarget({ url: `${server.url}other`, token: null });
		const Component = resolveSurface("/workflows")!.Component;
		return <Component active paneId={focusedPaneId} />;
	}
	const setup = await testRender(
		<ThemeProvider reducedMotion>
			<CoreProvider initial={{ url: server.url.toString(), token: null }}>
				<ToastProvider>
					<WorkspaceProvider>
						<View />
					</WorkspaceProvider>
				</ToastProvider>
			</CoreProvider>
		</ThemeProvider>,
		{ width: 100, height: 30 }
	);
	const press = async (name: string) => {
		await act(async () => {
			setup.renderer.keyInput.emit(
				"keypress",
				new KeyEvent({
					name,
					sequence: "",
					shift: false,
					ctrl: false,
					meta: false,
					option: false,
					eventType: "press",
					repeated: false,
					number: false,
					raw: "",
					source: "raw",
				})
			);
		});
		await setup.renderOnce();
	};
	try {
		await act(async () => {
			await Bun.sleep(50);
		});
		await setup.renderOnce();
		expect(setup.captureCharFrame()).toContain("Fixture flow");
		await press("return");
		await press("return");
		await act(async () => {
			await until(() => starts === 1);
			await Bun.sleep(30);
		});
		await act(async () => {
			await until(() => polls === 1);
			await Bun.sleep(3100);
		});
		expect(polls).toBe(1);
		await press("escape");
		await until(() => cancelled === 1);
		expect(setup.captureCharFrame()).not.toContain("run-1");
		await press("return");
		await press("return");
		await until(() => starts === 2);
		await press("escape");
		await act(async () => {
			release(Response.json(run("run-2")));
			await Bun.sleep(50);
		});
		await setup.renderOnce();
		await act(async () => {
			await Bun.sleep(1600);
		});
		expect(polls).toBe(1);
		expect(setup.captureCharFrame()).not.toContain("run-2");
		await act(async () => {
			switchTarget();
		});
		await act(async () => {
			await until(() => switchedReads === 1);
			await Bun.sleep(30);
		});
		await press("return");
		await press("return");
		expect(starts).toBe(2);
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
		server.stop(true);
	}
}, 18_000);
