/* @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { act } from "react";
import { CoreProvider } from "../core/CoreContext.tsx";
import { useGatewayStatus } from "../overlays/gateway/status.ts";
import { testRender } from "./cli-test-render.ts";

async function until(predicate: () => boolean) {
	const deadline = Date.now() + 3000;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error("Gateway fixture timed out");
		}
		await Bun.sleep(10);
	}
}
test("Gateway polling skips pending reads, manual refresh replaces them and close releases them", async () => {
	let requests = 0;
	let cancelled = 0;
	let refresh!: () => void;
	const server = Bun.serve({
		port: 0,
		fetch() {
			requests++;
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
	function Probe() {
		const status = useGatewayStatus();
		refresh = status.refresh;
		return <text>{status.state.kind}</text>;
	}
	const setup = await testRender(
		<CoreProvider initial={{ url: server.url.toString(), token: null }}>
			<Probe />
		</CoreProvider>,
		{ width: 40, height: 5 }
	);
	let closed = false;
	try {
		await act(async () => {
			await until(() => requests === 1);
			await Bun.sleep(5200);
		});
		expect(requests).toBe(1);
		await act(async () => {
			refresh();
		});
		await act(async () => {
			await until(() => requests === 2 && cancelled === 1);
		});
		await act(async () => {
			setup.renderer.destroy();
		});
		closed = true;
		await until(() => cancelled === 2);
		refresh();
		await Bun.sleep(30);
		expect(requests).toBe(2);
	} finally {
		if (!closed) {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
		server.stop(true);
	}
}, 15_000);
