import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { RunSummary } from "./useRuns.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { useReconnectRetryRecovery } = await import(
	"./useReconnectRetryRecovery.ts"
);
const {
	CHAT_RECOVERY_STOP_EVENT,
	CHAT_TURN_STARTED_EVENT,
	reconnectRetryStorageKey,
} = await import("../lib/reconnect-retry.ts");
type Options = Parameters<typeof useReconnectRetryRecovery>[0];
const nodeUrl = "http://reload.test";
const storageKey = reconnectRetryStorageKey(nodeUrl);
let options: Options;
let root = createRoot(document.createElement("div"));
const originalFetch = globalThis.fetch;
let freshRuns: Options["runs"] = [];
/** Core's complete /api/runs summary; fetchRuns drops partial rows. */
function run(id: string, runStatus: string): RunSummary {
	return {
		agent_id: null,
		branch: null,
		created_at: 1_760_000_000,
		folder_path: null,
		id,
		message_count: 1,
		run_status: runStatus,
		title: null,
		updated_at: 1_760_000_000,
		worktree_path: null,
	};
}
let failedSnapshots = 0;
let rejectedPosts = false;
const retries: string[] = [];
// Core's `/api/runs` serializes complete ConversationSummary rows, and the
// snapshot reader drops anything less.
function coreRunSummary(run: Options["runs"][number]) {
	return {
		agent_id: null,
		branch: null,
		created_at: 1,
		folder_path: null,
		message_count: 1,
		title: null,
		updated_at: 1,
		worktree_path: null,
		...run,
	};
}
function Harness() {
	useReconnectRetryRecovery(options);
	return null;
}
async function render() {
	await act(async () => {
		root.render(<Harness />);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}
function prepare({
	online = true,
	development = true,
}: {
	online?: boolean;
	development?: boolean;
} = {}) {
	options = {
		activeNode: { url: nodeUrl, token: null },
		activeNodeOnline: online,
		devRecovery: development,
		pluginEnabled: false,
		probeActiveNode: async () => undefined,
		runs: [],
	};
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/api/runs")) {
				if (failedSnapshots > 0) {
					failedSnapshots -= 1;
					return new Response(null, { status: 503 });
				}
				return Response.json({ runs: freshRuns.map(coreRunSummary) });
			}
			retries.push(url);
			if (rejectedPosts) {
				return new Response(null, { status: 503 });
			}
			return Response.json({ ok: true });
		},
		{ preconnect: originalFetch.preconnect }
	);
}
afterEach(async () => {
	await act(async () => root.unmount());
	root = createRoot(document.createElement("div"));
	globalThis.fetch = originalFetch;
	localStorage.clear();
	freshRuns = [];
	failedSnapshots = 0;
	rejectedPosts = false;
	retries.length = 0;
});
test("dev recovery retries a warming-up snapshot without consuming the POST attempt", async () => {
	prepare();
	failedSnapshots = 1;
	localStorage.setItem(
		storageKey,
		JSON.stringify([
			{ conversationId: "warming", capturedAt: Date.now(), attempts: 0 },
		])
	);
	freshRuns = [run("warming", "interrupted")];
	await render();
	expect(retries).toHaveLength(0);
	await act(async () => new Promise((resolve) => setTimeout(resolve, 2100)));
	expect(retries).toEqual([`${nodeUrl}/api/chat/retry/warming`]);
});
test("dev mount recovers interrupted turns once while live and completed turns stay untouched", async () => {
	prepare();
	localStorage.setItem(
		storageKey,
		JSON.stringify(
			["interrupted", "live", "completed"].map((conversationId) => ({
				conversationId,
				capturedAt: Date.now(),
				attempts: 0,
			}))
		)
	);
	freshRuns = [
		run("interrupted", "interrupted"),
		run("live", "running"),
		run("completed", "completed"),
	];
	await render();
	expect(retries).toEqual([`${nodeUrl}/api/chat/retry/interrupted`]);
	expect(JSON.parse(localStorage.getItem(storageKey) ?? "[]")).toContainEqual(
		expect.objectContaining({ conversationId: "interrupted", attempts: 1 })
	);
	await act(async () => root.unmount());
	root = createRoot(document.createElement("div"));
	await render();
	expect(retries).toHaveLength(1);
});
test("recovery waits for a confirmed online node and release builds remain opt in", async () => {
	prepare({ online: false });
	localStorage.setItem(
		storageKey,
		JSON.stringify([
			{ conversationId: "interrupted", capturedAt: Date.now(), attempts: 0 },
		])
	);
	freshRuns = [run("interrupted", "interrupted")];
	await render();
	expect(retries).toHaveLength(0);
	options = { ...options, activeNodeOnline: true };
	await render();
	expect(retries).toHaveLength(1);
	await act(async () => root.unmount());
	root = createRoot(document.createElement("div"));
	prepare({ development: false });
	localStorage.setItem(
		storageKey,
		JSON.stringify([
			{ conversationId: "release", capturedAt: Date.now(), attempts: 0 },
		])
	);
	freshRuns = [run("release", "interrupted")];
	await render();
	expect(retries).toHaveLength(1);
});
test("pagehide captures running turns and an explicit Stop cannot be recaptured", async () => {
	prepare();
	options = { ...options, runs: [run("running", "running")] };
	await render();
	expect(localStorage.getItem(storageKey)).toContain("running");
	window.dispatchEvent(
		new CustomEvent(CHAT_RECOVERY_STOP_EVENT, {
			detail: { conversationId: "running", nodeUrl },
		})
	);
	window.dispatchEvent(new Event("pagehide"));
	expect(localStorage.getItem(storageKey)).toBeNull();
});
test("Stop wins over a snapshot arriving after the stopped turn became terminal", async () => {
	prepare();
	localStorage.setItem(
		storageKey,
		JSON.stringify([
			{ conversationId: "stop-race", capturedAt: Date.now(), attempts: 0 },
		])
	);
	options = { ...options, runs: [run("stop-race", "running")] };
	let completeSnapshot: (response: Response) => void = () => {
		throw new Error("snapshot was not requested");
	};
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL) => {
			if (String(input).endsWith("/api/runs")) {
				return new Promise<Response>((resolve) => {
					completeSnapshot = resolve;
				});
			}
			retries.push(String(input));
			return Promise.resolve(Response.json({ ok: true }));
		},
		{ preconnect: originalFetch.preconnect }
	);
	await render();
	window.dispatchEvent(
		new CustomEvent(CHAT_RECOVERY_STOP_EVENT, {
			detail: { conversationId: "stop-race", nodeUrl },
		})
	);
	options = {
		...options,
		runs: [run("stop-race", "interrupted")],
	};
	await render();
	await act(async () => {
		completeSnapshot(Response.json({ runs: options.runs }));
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(retries).toHaveLength(0);
});
test("a rejected dev recovery remains claimed across repeated reloads", async () => {
	prepare();
	rejectedPosts = true;
	localStorage.setItem(
		storageKey,
		JSON.stringify([
			{ conversationId: "rejected", capturedAt: Date.now(), attempts: 0 },
		])
	);
	freshRuns = [run("rejected", "interrupted")];
	await render();
	expect(retries).toHaveLength(1);
	await act(async () => root.unmount());
	root = createRoot(document.createElement("div"));
	await render();
	expect(retries).toHaveLength(1);
});
test("dev recovery rearms after a running turn is confirmed for a later restart", async () => {
	prepare();
	localStorage.setItem(
		storageKey,
		JSON.stringify([
			{ conversationId: "repeat", capturedAt: Date.now(), attempts: 0 },
		])
	);
	freshRuns = [run("repeat", "interrupted")];
	await render();
	expect(retries).toHaveLength(1);
	options = { ...options, runs: [run("repeat", "running")] };
	await render();
	expect(JSON.parse(localStorage.getItem(storageKey) ?? "[]")).toContainEqual(
		expect.objectContaining({ conversationId: "repeat", attempts: 0 })
	);
	await act(async () => root.unmount());
	root = createRoot(document.createElement("div"));
	options = { ...options, runs: [run("repeat", "interrupted")] };
	await render();
	expect(retries).toHaveLength(2);
});
test("release reconnect retry remains opt in and can recover a later genuine outage", async () => {
	prepare({ online: false, development: false });
	options = {
		...options,
		pluginEnabled: true,
		runs: [run("release-repeat", "running")],
	};
	freshRuns = [run("release-repeat", "interrupted")];
	await render();
	options = { ...options, activeNodeOnline: true };
	await render();
	expect(retries).toHaveLength(1);
	options = { ...options, activeNodeOnline: false };
	await render();
	options = { ...options, activeNodeOnline: true };
	await render();
	expect(retries).toHaveLength(2);
});
test("a confirmed fresh turn after Stop can recover without an intervening terminal snapshot", async () => {
	prepare();
	options = { ...options, runs: [run("rapid", "running")] };
	await render();
	window.dispatchEvent(
		new CustomEvent(CHAT_RECOVERY_STOP_EVENT, {
			detail: { conversationId: "rapid", nodeUrl },
		})
	);
	window.dispatchEvent(
		new CustomEvent(CHAT_TURN_STARTED_EVENT, {
			detail: { conversationId: "rapid", nodeUrl },
		})
	);
	window.dispatchEvent(new Event("pagehide"));
	expect(localStorage.getItem(storageKey)).toContain("rapid");
	await act(async () => root.unmount());
	root = createRoot(document.createElement("div"));
	freshRuns = [run("rapid", "interrupted")];
	options = { ...options, runs: freshRuns };
	await render();
	expect(retries).toEqual([`${nodeUrl}/api/chat/retry/rapid`]);
});
test("recovery ignores Stop and Start events from another node", async () => {
	prepare();
	options = { ...options, runs: [run("local", "running")] };
	await render();
	window.dispatchEvent(
		new CustomEvent(CHAT_RECOVERY_STOP_EVENT, {
			detail: { conversationId: "local", nodeUrl: "http://other.test" },
		})
	);
	window.dispatchEvent(
		new CustomEvent(CHAT_TURN_STARTED_EVENT, {
			detail: { conversationId: "remote", nodeUrl: "http://other.test" },
		})
	);
	expect(localStorage.getItem(storageKey)).toContain("local");
	expect(localStorage.getItem(storageKey)).not.toContain("remote");
});
test("Stop survives remount with stale running rows until a fresh Start permits recovery", async () => {
	prepare();
	options = {
		...options,
		runs: [run("durable-stop", "running")],
	};
	freshRuns = options.runs;
	await render();
	window.dispatchEvent(
		new CustomEvent(CHAT_RECOVERY_STOP_EVENT, {
			detail: { conversationId: "durable-stop", nodeUrl },
		})
	);
	expect(localStorage.getItem(`${storageKey}:stopped`)).toContain(
		"durable-stop"
	);
	await act(async () => root.unmount());
	root = createRoot(document.createElement("div"));
	await render();
	expect(localStorage.getItem(storageKey)).toBeNull();
	freshRuns = [run("durable-stop", "interrupted")];
	options = { ...options, runs: freshRuns };
	await render();
	await act(async () => root.unmount());
	root = createRoot(document.createElement("div"));
	await render();
	expect(retries).toHaveLength(0);
	window.dispatchEvent(
		new CustomEvent(CHAT_TURN_STARTED_EVENT, {
			detail: { conversationId: "durable-stop", nodeUrl },
		})
	);
	expect(localStorage.getItem(`${storageKey}:stopped`)).toBeNull();
	options = {
		...options,
		runs: [run("durable-stop", "running")],
	};
	await render();
	await act(async () => root.unmount());
	root = createRoot(document.createElement("div"));
	options = { ...options, runs: freshRuns };
	await render();
	expect(retries).toEqual([`${nodeUrl}/api/chat/retry/durable-stop`]);
});
test("release opt-in respects a durable Stop through an outage and remount", async () => {
	prepare({ online: false, development: false });
	options = {
		...options,
		pluginEnabled: true,
		runs: [run("release-stop", "running")],
	};
	freshRuns = [run("release-stop", "interrupted")];
	await render();
	window.dispatchEvent(
		new CustomEvent(CHAT_RECOVERY_STOP_EVENT, {
			detail: { conversationId: "release-stop", nodeUrl },
		})
	);
	await act(async () => root.unmount());
	root = createRoot(document.createElement("div"));
	await render();
	options = { ...options, activeNodeOnline: true };
	await render();
	expect(retries).toHaveLength(0);
	expect(localStorage.getItem(storageKey)).toBeNull();
	options = { ...options, runs: freshRuns };
	await render();
	expect(localStorage.getItem(`${storageKey}:stopped`)).toBeNull();
});
test("release fresh Start clears Stop intent without enabling capture of every turn", async () => {
	prepare({ development: false });
	options = {
		...options,
		pluginEnabled: true,
		runs: [run("release-start", "running")],
	};
	await render();
	window.dispatchEvent(
		new CustomEvent(CHAT_RECOVERY_STOP_EVENT, {
			detail: { conversationId: "release-start", nodeUrl },
		})
	);
	window.dispatchEvent(
		new CustomEvent(CHAT_TURN_STARTED_EVENT, {
			detail: { conversationId: "release-start", nodeUrl },
		})
	);
	expect(localStorage.getItem(`${storageKey}:stopped`)).toBeNull();
	expect(localStorage.getItem(storageKey)).toBeNull();
	options = { ...options, activeNodeOnline: false };
	await render();
	expect(localStorage.getItem(storageKey)).toContain("release-start");
});
