import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DownloadTask } from "@/src/lib/api/downloads.ts";

const originalFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const errors: unknown[] = [];
const node = {
	url: "http://downloads.fixture.test",
	token: "node-token",
	userJwt: null,
};
mock.module("@/lib/auth-client.ts", () => ({
	TOKEN_KEY: "test-token",
	getActiveToken: () => globalThis.localStorage?.getItem("test-token") ?? null,
}));
mock.module("@/src/lib/realtime/jwt.ts", () => ({
	getRealtimeJwt: () => null,
}));
mock.module("@/src/store/useNodeStore.ts", () => ({
	useNodeStore: <T,>(
		select: (state: { getActiveNode: () => typeof node }) => T
	) => select({ getActiveNode: () => node }),
}));
mock.module("@ryu/ui/components/sileo", () => ({
	toast: { error: (message: unknown) => errors.push(message) },
}));
// Replace tray chrome only. The download component, hook, store and HTTP client
// are real; every action reaches the fixture through its production API helper.
mock.module("@/src/components/shell/TrayPopover.tsx", () => ({
	TrayRow: ({
		actions,
		title,
		meta,
		busy,
	}: {
		actions: ReactNode;
		title: ReactNode;
		meta: string;
		busy?: boolean;
	}) => (
		<div>
			{title}
			{meta}
			{busy ? <span role="status">Working</span> : actions}
		</div>
	),
	TrayIconAction: ({
		label,
		onClick,
	}: {
		label: string;
		onClick: () => void;
	}) => (
		<button onClick={onClick} type="button">
			{label}
		</button>
	),
	TrayAction: ({ label, onClick }: { label: string; onClick: () => void }) => (
		<button onClick={onClick} type="button">
			{label}
		</button>
	),
	trayMeta: (...parts: string[]) => parts.filter(Boolean).join(" · "),
}));
const { DownloadRow } = await import("./DownloadRow.tsx");
const { useDownloadBulkActions } = await import(
	"@/src/hooks/useDownloadBulkActions.ts"
);
const { useDownloadsStore } = await import("@/src/store/useDownloadsStore.ts");
const api = await import("@/src/lib/api/downloads.ts");

const calls: { method: string; path: string; authorization: string | null }[] =
	[];
let reply: (path: string, method: string) => Promise<Response>;
let container: HTMLDivElement;
let root: Root;
function task(id: string, state: DownloadTask["state"]): DownloadTask {
	return {
		id,
		state,
		created_at: 1,
		updated_at: 1,
		dest_path: null,
		error: null,
		kind: "model",
		label: id,
		received_bytes: 50,
		retryable: true,
		speed_bps: null,
		total_bytes: 100,
		url: null,
	};
}
beforeEach(() => {
	calls.length = 0;
	errors.length = 0;
	useDownloadsStore.getState().reset();
	reply = async () => NativeResponse.json({ ok: true, cleared: 1 });
	// SAFETY: This async fixture implements fetch input, options and Response output; only networking is replaced.
	globalThis.fetch = (async (input, init) => {
		const path = new URL(String(input)).pathname;
		const method = init?.method ?? "GET";
		calls.push({
			path,
			method,
			authorization: new Headers(init?.headers).get("Authorization"),
		});
		return reply(path, method);
	}) as typeof fetch;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	globalThis.fetch = originalFetch;
});
async function click(label: string) {
	const button = Array.from(container.querySelectorAll("button")).find(
		(item) => item.textContent === label
	);
	if (!button) {
		throw new Error(`Missing action ${label}`);
	}
	await act(async () => {
		button.click();
	});
}
for (const [state, label, action, method] of [
	["active", "Pause", "pause", "POST"],
	["paused", "Resume", "resume", "POST"],
	["queued", "Resume", "resume", "POST"],
	["verifying", "Cancel", "cancel", "POST"],
	["failed", "Retry", "retry", "POST"],
	["completed", "Dismiss", "", "DELETE"],
] as const) {
	test(`${label} routes the selected ${state} task to the active node and reports rejection before retry`, async () => {
		const row = task("artifact /#?", state);
		useDownloadsStore.getState().applySnapshot([row]);
		reply = async () => NativeResponse.json({ ok: false });
		await act(async () =>
			root.render(<DownloadRow friendly={false} task={row} />)
		);
		await click(label);
		expect(calls).toEqual([
			{
				path: `/api/downloads/artifact%20%2F%23%3F${action ? `/${action}` : ""}`,
				method,
				authorization: "Bearer node-token",
			},
		]);
		expect(errors).toEqual([
			{
				title: `Couldn't ${label.toLowerCase()} the download`,
				description: "Download action was rejected by Core",
			},
		]);
		expect(useDownloadsStore.getState().tasks[row.id]).toEqual(row);
		reply = async () => NativeResponse.json({ ok: true });
		await click(label);
		expect(calls).toHaveLength(2);
		expect(errors).toHaveLength(1);
		if (label === "Dismiss") {
			expect(useDownloadsStore.getState().tasks[row.id]).toBeUndefined();
		}
	});
}
test("an in-flight action hides further controls until the request finishes", async () => {
	let finish: ((value: Response) => void) | undefined;
	reply = () =>
		new Promise((resolve) => {
			finish = resolve;
		});
	await act(async () =>
		root.render(<DownloadRow friendly={false} task={task("a", "active")} />)
	);
	await click("Pause");
	expect(container.querySelectorAll("button")).toHaveLength(0);
	expect(container.querySelector('[role="status"]')?.textContent).toBe(
		"Working"
	);
	await act(async () => finish?.(NativeResponse.json({ ok: true })));
	expect(container.querySelectorAll("button")).toHaveLength(2);
	expect(calls).toHaveLength(1);
});

let bulk: ReturnType<typeof useDownloadBulkActions>;
function BulkHarness({ tasks }: { tasks: DownloadTask[] }) {
	bulk = useDownloadBulkActions(tasks);
	return <span>{String(bulk.pending)}</span>;
}
async function mountBulk(tasks: DownloadTask[]) {
	useDownloadsStore.getState().applySnapshot(tasks);
	await act(async () => root.render(<BulkHarness tasks={tasks} />));
}
test("clear unfinished cancels before clearing, removes only acknowledged rows and reports partial failure", async () => {
	await mountBulk([
		task("a", "active"),
		task("b", "paused"),
		task("c", "failed"),
		task("done", "completed"),
	]);
	reply = async (path, method) =>
		NativeResponse.json({
			ok: !(path === "/api/downloads/b" && method === "DELETE"),
		});
	await act(async () => {
		await bulk.clearUnfinished();
	});
	for (const id of ["a", "b", "c"]) {
		expect(
			calls.findIndex((call) => call.path === `/api/downloads/${id}/cancel`)
		).toBeLessThan(
			calls.findIndex((call) => call.path === `/api/downloads/${id}`)
		);
	}
	expect(Object.keys(useDownloadsStore.getState().tasks).sort()).toEqual([
		"b",
		"done",
	]);
	expect(errors).toEqual(["Couldn't clear 1 of 3 downloads."]);
	expect(bulk.pending).toBe(false);
});
test("clear finished leaves active and failed rows, clears durable history even with no live rows", async () => {
	await mountBulk([
		task("done", "completed"),
		task("cancelled", "cancelled"),
		task("active", "active"),
		task("failed", "failed"),
	]);
	await act(async () => {
		await bulk.clearFinished();
	});
	expect(calls.map(({ method, path }) => [method, path])).toEqual([
		["DELETE", "/api/downloads/done"],
		["DELETE", "/api/downloads/cancelled"],
		["DELETE", "/api/downloads/history"],
	]);
	expect(Object.keys(useDownloadsStore.getState().tasks).sort()).toEqual([
		"active",
		"failed",
	]);
	await mountBulk([]);
	calls.length = 0;
	await act(async () => {
		await bulk.clearFinished();
	});
	expect(calls.map((call) => call.path)).toEqual(["/api/downloads/history"]);
});
test("history clear rejection and transport failure are surfaced and release pending state", async () => {
	await mountBulk([]);
	reply = async () => NativeResponse.json({ ok: false });
	await act(async () => {
		await bulk.clearFinished();
	});
	expect(errors).toEqual(["Couldn't clear those downloads."]);
	expect(bulk.pending).toBe(false);
	reply = async () => {
		throw new Error("offline");
	};
	await expect(api.clearDownloadHistory(node)).rejects.toThrow("offline");
});

const openedTabs: string[] = [];
let refreshUpdates = 0;
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => node,
}));
mock.module("@/src/hooks/useFriendlyMode.ts", () => ({
	useFriendlyMode: () => [false],
}));
mock.module("@/src/hooks/useAvailableUpdates.ts", () => ({
	useAvailableUpdates: () => ({
		updates: [],
		loading: false,
		refresh: () => {
			refreshUpdates += 1;
		},
	}),
}));
mock.module("@/src/contexts/TabsContext.tsx", () => ({
	useTabSelector: <T,>(
		select: (state: { openTab: (path: string) => void }) => T
	) => select({ openTab: (path: string) => openedTabs.push(path) }),
}));
mock.module("@/src/components/downloads/AvailableUpdates.tsx", () => ({
	AvailableUpdates: () => null,
}));
mock.module(
	"@/src/components/downloads/DownloadConcurrencyControl.tsx",
	() => ({ DownloadConcurrencyControl: () => null })
);
mock.module("@/src/lib/route-queries.ts", () => ({
	downloadsHistoryQuery: (target: typeof node) => ({
		queryKey: ["download-history", target.url],
		queryFn: () => api.listDownloadHistory(target),
	}),
}));
mock.module("@ryu/ui/components/pull-to-refresh.tsx", () => ({
	PullToRefresh: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
}));
mock.module("@ryu/ui/components/button.tsx", () => ({
	Button: ({
		children,
		onClick,
		disabled,
		loading,
	}: {
		children: ReactNode;
		onClick: () => void;
		disabled?: boolean;
		loading?: boolean;
	}) => (
		<button disabled={disabled || loading} onClick={onClick} type="button">
			{children}
		</button>
	),
}));
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { default: DownloadsPage } = await import(
	"@/src/pages/DownloadsPage.tsx"
);
async function waitUntil(condition: () => boolean) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (condition()) {
			return;
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
	}
	throw new Error("Download page did not reach the expected state");
}
async function mountPage() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	await act(async () =>
		root.render(
			<QueryClientProvider client={queryClient}>
				<DownloadsPage />
			</QueryClientProvider>
		)
	);
	return queryClient;
}
test("Downloads merges durable and live history newest first with live records winning duplicate IDs", async () => {
	useDownloadsStore.getState().applySnapshot([
		{
			...task("duplicate", "completed"),
			label: "Live record",
			updated_at: 40,
		},
		task("running", "paused"),
	]);
	reply = async () =>
		NativeResponse.json({
			history: [
				{
					...task("duplicate", "completed"),
					label: "Old persisted record",
					updated_at: 10,
				},
				{
					...task("older", "cancelled"),
					label: "Older saved record",
					updated_at: 20,
				},
				{
					...task("newest", "failed"),
					label: "Newest saved record",
					updated_at: 50,
				},
			],
		});
	const client = await mountPage();
	try {
		await waitUntil(
			() => container.textContent?.includes("Newest saved record") ?? false
		);
		const content = container.textContent ?? "";
		expect(content).not.toContain("Old persisted record");
		expect(content.match(/Live record/g)).toHaveLength(1);
		expect(content.indexOf("Newest saved record")).toBeLessThan(
			content.indexOf("Live record")
		);
		expect(content.indexOf("Live record")).toBeLessThan(
			content.indexOf("Older saved record")
		);
		expect(content.indexOf("running")).toBeLessThan(content.indexOf("History"));
	} finally {
		client.clear();
	}
});
test("clear finished removes persisted history by reading back Core, then empty-state Store navigation opens the actual route", async () => {
	let history = [task("persisted", "completed")];
	openedTabs.length = 0;
	reply = async (_path, method) => {
		if (method === "DELETE") {
			history = [];
			return NativeResponse.json({ ok: true, cleared: 1 });
		}
		return NativeResponse.json({ history });
	};
	const client = await mountPage();
	try {
		await waitUntil(
			() => container.textContent?.includes("persisted") ?? false
		);
		await click("Clear finished");
		await waitUntil(
			() => container.textContent?.includes("Nothing downloading") ?? false
		);
		expect(calls.map(({ method, path }) => [method, path])).toEqual([
			["GET", "/api/downloads/history"],
			["DELETE", "/api/downloads/history"],
			["GET", "/api/downloads/history"],
		]);
		await click("Browse the Store");
		expect(openedTabs).toEqual(["/store"]);
	} finally {
		client.clear();
	}
});
test("Refresh requests both update and durable history feeds and immediately renders new results", async () => {
	reply = async () => NativeResponse.json({ history: [] });
	refreshUpdates = 0;
	const client = await mountPage();
	try {
		await waitUntil(
			() => container.textContent?.includes("Nothing downloading") ?? false
		);
		reply = async () =>
			NativeResponse.json({ history: [task("new-history", "completed")] });
		await click("Refresh");
		await waitUntil(
			() => container.textContent?.includes("new-history") ?? false
		);
		expect(refreshUpdates).toBe(1);
		expect(calls.filter((call) => call.method === "GET")).toHaveLength(2);
		expect(container.textContent).toContain("Refreshing…");
	} finally {
		client.clear();
	}
});
