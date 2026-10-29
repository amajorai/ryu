import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { RunSummary } from "@/src/hooks/useRuns.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { RunStreamFrame } from "@/src/lib/api/runStream.ts";

if (!globalThis.document) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let node = { url: "https://a.test", token: "one", userJwt: "caller" };
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => node,
}));
const streams: Array<{
	signal: AbortSignal;
	emit: (frame: RunStreamFrame) => void;
}> = [];
mock.module("@/src/lib/api/runStream.ts", () => ({
	streamRuns: (
		_target: ApiTarget,
		emit: (frame: RunStreamFrame) => void,
		signal: AbortSignal
	) => {
		streams.push({ signal, emit });
		return new Promise<void>((resolve) =>
			signal.addEventListener("abort", () => resolve(), { once: true })
		);
	},
}));
const { useRuns } = await import("@/src/hooks/useRuns.ts");
const { useAgentRunLiveActivities } = await import("./agent-runs.ts");
const { useLiveActivityStore } = await import(
	"@/src/store/useLiveActivityStore.ts"
);
const originalNotification = globalThis.Notification;
const Notice = { permission: "denied" };
Reflect.set(globalThis, "Notification", Notice);
Reflect.set(window, "Notification", Notice);
const originalTimeout = globalThis.setTimeout;
const originalClear = globalThis.clearTimeout;
const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
Reflect.set(globalThis, "setTimeout", (callback: () => void, ms: number) => {
	const timer = originalTimeout(callback, ms);
	if (ms === 8000) {
		timers.set(timer, callback);
	}
	return timer;
});
Reflect.set(
	globalThis,
	"clearTimeout",
	(timer: ReturnType<typeof setTimeout>) => {
		timers.delete(timer);
		originalClear(timer);
	}
);
const root = createRoot(document.createElement("div"));
function Monitor() {
	useRuns();
	return null;
}
function Adapter() {
	useAgentRunLiveActivities();
	return null;
}
const render = async (adapter = true) => {
	await act(() =>
		root.render(
			<>
				<Monitor />
				{adapter && <Adapter />}
			</>
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
const cards = () => useLiveActivityStore.getState().activities;
afterEach(async () => {
	await act(() => root.unmount());
	useLiveActivityStore.getState().reset();
	Reflect.set(globalThis, "setTimeout", originalTimeout);
	Reflect.set(globalThis, "clearTimeout", originalClear);
	Reflect.set(globalThis, "Notification", originalNotification);
	Reflect.set(window, "Notification", originalNotification);
});
test("live cards share the run feed, preserve other sources and cancel obsolete linger timers", async () => {
	useLiveActivityStore.getState().upsert({
		id: "download:other",
		appId: "shell",
		kind: "download",
		title: "Other",
		detail: "Fixture download",
		status: "running",
		startedAt: 0,
		updatedAt: 0,
	});
	await render();
	expect(streams).toHaveLength(1);
	expect(cards()["download:other"]).toBeDefined();
	await act(() => streams[0].emit({ type: "snapshot", runs: [run] }));
	expect(cards()["download:other"]).toBeDefined();
	expect(cards()["run:run"].status).toBe("running");
	await act(() =>
		streams[0].emit({ type: "run", run: { ...run, run_status: "completed" } })
	);
	expect(timers.size).toBe(1);
	await act(() =>
		streams[0].emit({ type: "run", run: { ...run, run_status: "completed" } })
	);
	expect(timers.size).toBe(1);
	const oldTimer = [...timers.values()][0];
	await act(() => streams[0].emit({ type: "run", run }));
	expect(timers.size).toBe(0);
	oldTimer();
	expect(cards()["run:run"].status).toBe("running");
	await act(() =>
		streams[0].emit({ type: "run", run: { ...run, run_status: "failed" } })
	);
	const oldNodeTimer = [...timers.values()][0];
	node = { ...node, url: "https://b.test" };
	await render();
	expect(streams).toHaveLength(2);
	expect(timers.size).toBe(0);
	expect(cards()["run:run"]).toBeUndefined();
	expect(cards()["download:other"]).toBeDefined();
	await act(() => streams[1].emit({ type: "snapshot", runs: [run] }));
	oldNodeTimer();
	expect(cards()["run:run"].status).toBe("running");
	await act(() =>
		streams[1].emit({ type: "run", run: { ...run, run_status: "completed" } })
	);
	await render(false);
	expect(timers.size).toBe(0);
	expect(cards()["run:run"]).toBeUndefined();
	expect(cards()["download:other"]).toBeDefined();
	expect(streams[1].signal.aborted).toBe(false);
	await render();
	expect(streams).toHaveLength(2);
	expect(cards()["run:run"].status).toBe("done");
});
