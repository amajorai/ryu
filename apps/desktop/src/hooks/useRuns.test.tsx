import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { RunStreamFrame } from "@/src/lib/api/runStream.ts";
import type { RunSummary } from "./useRuns.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let node = {
	url: "https://a.test",
	token: "one",
	userJwt: "caller",
	name: "A",
};
mock.module("./useActiveNode.ts", () => ({ useActiveNode: () => node }));
const streams: Array<{
	target: ApiTarget;
	signal: AbortSignal;
	emit: (frame: RunStreamFrame) => void;
}> = [];
mock.module("@/src/lib/api/runStream.ts", () => ({
	streamRuns: (
		target: ApiTarget,
		emit: (frame: RunStreamFrame) => void,
		signal: AbortSignal
	) => {
		streams.push({ target, emit, signal });
		return new Promise<void>((resolve) =>
			signal.addEventListener("abort", () => resolve(), { once: true })
		);
	},
}));
const { useRuns } = await import("./useRuns.ts");
const notices: string[] = [];
const originalNotification = globalThis.Notification;
class TestNotification {
	static permission = "granted";
	onclick: unknown;
	constructor(title: string) {
		notices.push(title);
	}
}
Reflect.set(globalThis, "Notification", TestNotification);
Reflect.set(window, "Notification", TestNotification);
const root = createRoot(document.createElement("div"));
const values: RunSummary[][] = [];
function Probe({ id }: { id: number }) {
	values[id] = useRuns().runs;
	return null;
}
const render = async (count: number) => {
	await act(() =>
		root.render(
			Array.from({ length: count }, (_, id) => <Probe id={id} key={id} />)
		)
	);
};
const run: RunSummary = {
	id: "run",
	agent_id: null,
	branch: null,
	created_at: 0,
	folder_path: null,
	message_count: 0,
	run_status: "running",
	title: "Fixture",
	updated_at: 0,
	worktree_path: null,
};
afterEach(async () => {
	await act(() => root.unmount());
	Reflect.set(globalThis, "Notification", originalNotification);
	Reflect.set(window, "Notification", originalNotification);
});
test("run views share one stream and notification, preserve current snapshots and reject obsolete frames", async () => {
	await render(2);
	expect(streams).toHaveLength(1);
	await act(() => streams[0].emit({ type: "snapshot", runs: [run] }));
	expect(values[0]).toBe(values[1]);
	expect(notices).toHaveLength(0);
	await act(() =>
		streams[0].emit({ type: "run", run: { ...run, run_status: "completed" } })
	);
	expect(notices).toEqual(["Run completed"]);
	node = { ...node, name: "Renamed" };
	await render(2);
	expect(streams).toHaveLength(1);
	await render(1);
	expect(streams[0].signal.aborted).toBe(false);
	await render(2);
	expect(streams).toHaveLength(1);
	expect(values[0]).toBe(values[1]);
	node = { ...node, url: "https://b.test" };
	await render(1);
	expect(streams).toHaveLength(2);
	expect(streams[0].signal.aborted).toBe(true);
	expect(values[0]).toEqual([]);
	await act(() => streams[0].emit({ type: "snapshot", runs: [run] }));
	expect(values[0]).toEqual([]);
	await act(() => streams[1].emit({ type: "snapshot", runs: [run] }));
	expect(values[0]).toEqual([run]);
	node = { ...node, token: "two" };
	await render(1);
	expect(streams).toHaveLength(3);
	expect(streams[1].signal.aborted).toBe(true);
	node = { ...node, userJwt: "next" };
	await render(1);
	expect(streams).toHaveLength(4);
	expect(streams[2].signal.aborted).toBe(true);
	await act(() => streams[3].emit({ type: "snapshot", runs: [run] }));
	await render(0);
	expect(streams[3].signal.aborted).toBe(true);
	await act(() =>
		streams[3].emit({ type: "run", run: { ...run, run_status: "failed" } })
	);
	expect(notices).toEqual(["Run completed"]);
});
