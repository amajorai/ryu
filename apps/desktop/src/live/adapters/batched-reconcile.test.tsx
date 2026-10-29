import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ApprovalRequest } from "@/src/lib/api/approvals.ts";
import type { DownloadTask } from "@/src/lib/api/downloads.ts";

if (!globalThis.document) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let approvals: ApprovalRequest[] = Array.from({ length: 100 }, (_, index) => ({
	id: `a${index}`,
	kind: "tool_call",
	status: "pending",
	title: `Approval ${index}`,
	summary: "Fixture",
	created_at: "2026-01-01T00:00:00Z",
	risk_tags: [],
}));
mock.module("@/src/hooks/useApprovals.ts", () => ({
	useApprovals: () => ({ approvals }),
}));
const { useApprovalLiveActivities } = await import("./approvals.ts");
const { useDownloadLiveActivities } = await import("./downloads.ts");
const { useDownloadsStore } = await import("@/src/store/useDownloadsStore.ts");
const { useLiveActivityStore } = await import(
	"@/src/store/useLiveActivityStore.ts"
);
const tasks: DownloadTask[] = Array.from({ length: 100 }, (_, index) => ({
	id: `d${index}`,
	kind: "model",
	state: "active",
	label: `Download ${index}`,
	created_at: index,
	updated_at: index,
	received_bytes: 100,
	total_bytes: 1000,
	speed_bps: null,
	dest_path: null,
	error: null,
	retryable: true,
	url: null,
}));
const root = createRoot(document.createElement("div"));
function Feeds() {
	useApprovalLiveActivities();
	useDownloadLiveActivities();
	return null;
}
let notifications = 0;
const unsubscribe = useLiveActivityStore.subscribe(() => {
	notifications++;
});
afterEach(async () => {
	await act(() => root.unmount());
	unsubscribe();
	useDownloadsStore.getState().reset();
	useLiveActivityStore.getState().reset();
});
test("bulk producer snapshots publish once and identical cards retain references", async () => {
	useLiveActivityStore.getState().upsert({
		id: "meeting:other",
		appId: "shell",
		kind: "meeting",
		status: "running",
		title: "Other",
		detail: "Fixture",
		startedAt: 0,
		updatedAt: 0,
	});
	useDownloadsStore.getState().applySnapshot(tasks);
	notifications = 0;
	await act(() => root.render(<Feeds />));
	expect(notifications).toBe(2);
	expect(Object.keys(useLiveActivityStore.getState().activities)).toHaveLength(
		201
	);
	const unchanged = useLiveActivityStore.getState().activities["download:d1"];
	notifications = 0;
	await act(() =>
		useDownloadsStore
			.getState()
			.applyUpdate({ ...tasks[0], received_bytes: 500 })
	);
	expect(notifications).toBe(1);
	expect(useLiveActivityStore.getState().activities["download:d1"]).toBe(
		unchanged
	);
	notifications = 0;
	await act(() =>
		useDownloadsStore.getState().applySnapshot(
			Object.values(useDownloadsStore.getState().tasks).map((task) => ({
				...task,
			}))
		)
	);
	expect(notifications).toBe(0);
	approvals = approvals.map((item) => ({ ...item }));
	await act(() => root.render(<Feeds />));
	expect(notifications).toBe(0);
	await act(() =>
		useDownloadsStore
			.getState()
			.applyUpdate({ ...tasks[0], state: "completed" })
	);
	expect(notifications).toBe(1);
	expect(
		useLiveActivityStore.getState().activities["download:d0"]
	).toBeUndefined();
	notifications = 0;
	approvals = approvals.slice(1);
	await act(() => root.render(<Feeds />));
	expect(notifications).toBe(1);
	expect(
		useLiveActivityStore.getState().activities["approval:a0"]
	).toBeUndefined();
	expect(
		useLiveActivityStore.getState().activities["meeting:other"]
	).toBeDefined();
	notifications = 0;
	useLiveActivityStore
		.getState()
		.upsert({ ...unchanged, action: { kind: "route", path: "/downloads" } });
	useLiveActivityStore.getState().remove("missing");
	expect(notifications).toBe(0);
});
