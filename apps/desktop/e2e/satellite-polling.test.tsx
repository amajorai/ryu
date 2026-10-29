import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DeviceAuthStatus } from "../../../apps-store/pull-requests/ui/src/types.ts";
import type {
	BootstrapResponse,
	Scan,
} from "../../../apps-store/security/ui/src/data.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// Mount the actual app effects, stubbing only visual controls and sidecar I/O.
function Control({ children, open }: { children?: ReactNode; open?: boolean }) {
	return open === false ? null : <div>{children}</div>;
}
function Button({
	children,
	onClick,
	disabled,
}: {
	children?: ReactNode;
	onClick?: () => void;
	disabled?: boolean;
}) {
	return (
		<button disabled={disabled} onClick={onClick} type="button">
			{children}
		</button>
	);
}
const controlNames = [
	"Badge",
	"Dialog",
	"DialogContent",
	"DialogDescription",
	"DialogFooter",
	"DialogHeader",
	"DialogTitle",
	"Input",
	"Select",
	"SelectContent",
	"SelectItem",
	"SelectTrigger",
	"SelectValue",
	"Spinner",
	"Switch",
	"Textarea",
];
mock.module("@ryu/blocks/companion/controls", () => ({
	...Object.fromEntries(controlNames.map((name) => [name, Control])),
	Button,
}));
mock.module("@ryu/blocks/companion/app-ui", () => ({
	RyuAppActions: Control,
	RyuAppEmpty: Control,
	RyuAppList: Control,
	RyuAppListItem: Control,
	RyuAppMain: Control,
	RyuAppToolbar: Control,
}));
mock.module("@ryu/ui/components/native-select.tsx", () => ({
	NativeSelect: Control,
	NativeSelectOption: Control,
}));
mock.module("@ryu/ui/components/progress.tsx", () => ({
	Progress: Control,
	ProgressLabel: Control,
	ProgressValue: () => null,
}));
mock.module("@ryu/ui/components/tabs.tsx", () => ({
	Tabs: Control,
	TabsList: Control,
	TabsContent: Control,
	TabsTrigger: Control,
}));
mock.module("@ryu/ui/components/checkbox.tsx", () => ({ Checkbox: Control }));
mock.module("@ryu/ui/components/dialog.tsx", () => ({
	Dialog: Control,
	DialogContent: Control,
	DialogDescription: Control,
	DialogHeader: Control,
	DialogTitle: Control,
}));
mock.module("@ryu/ui/components/dropdown-menu.tsx", () => ({
	DropdownMenu: Control,
	DropdownMenuContent: Control,
	DropdownMenuItem: Control,
	DropdownMenuTrigger: Control,
}));

const scan: Scan = {
	id: "scan-a",
	repositoryId: "repo-a",
	name: "Performance regression scan",
	status: "running",
	kind: "codebase",
	scope: "entire",
	progress: 10,
	coverage: 10,
	deep: false,
	evidenceLevel: "static-local",
	fileCount: 10,
	findingCount: 0,
	model: "local",
	phase: "analyze",
	phases: [],
	reasoningEffort: "medium",
	startedAt: "2026-09-22T00:00:00Z",
	additionalContext: { attackVectors: "", focusAreas: "", securityContext: "" },
};
const bootstrap: BootstrapResponse = {
	capabilities: {
		agentVerification: false,
		evidenceLevel: "static-local",
		networkAccess: false,
		patchApplication: false,
	},
	findings: [],
	scans: [scan],
	repositories: [
		{
			id: "repo-a",
			name: "Fixture repository",
			branch: "main",
			createdAt: scan.startedAt,
			fileCount: 10,
			findingCount: 0,
			head: "fixture",
			path: "/fixture",
			scanCount: 1,
			status: "ready",
		},
	],
};
const scanCalls: Array<(value: { scan: Scan; findings: [] }) => void> = [];
mock.module("../../../apps-store/security/ui/src/bridge.ts", () => ({
	getBootstrap: async () => bootstrap,
	getScan: () =>
		new Promise<{ scan: Scan; findings: [] }>((resolve) => {
			scanCalls.push(resolve);
		}),
	cancelScan: mock(),
	createRepository: mock(),
	createScan: mock(),
	generatePatch: mock(),
	updateFindingStatus: mock(),
}));

const pendingAuth: DeviceAuthStatus = {
	id: "auth-a",
	state: "pending",
	startedAt: scan.startedAt,
	expiresAt: "2026-09-22T00:15:00Z",
	userCode: "TEST-CODE",
};
let authReads = 0;
let statusReads = 0;
let authenticated = false;
const authCalls: Array<(value: DeviceAuthStatus) => void> = [];
mock.module("../../../apps-store/pull-requests/ui/src/api.ts", () => ({
	...Object.fromEntries(
		[
			"addComment",
			"addIssueComment",
			"addReview",
			"addStackLayer",
			"cancelDeviceAuth",
			"createStack",
			"getDiff",
			"getIssue",
			"getMergeStatus",
			"getPull",
			"listIssues",
			"listPulls",
			"mergePull",
			"setDraft",
			"setIssueState",
			"startDeviceAuth",
			"unstack",
		].map((name) => [name, mock()])
	),
	getStatus: () => {
		statusReads += 1;
		return authenticated
			? Promise.resolve({
					available: true,
					provider: "github",
					version: "test",
					viewer: { login: "fixture" },
				})
			: Promise.reject(new Error("Sign in to GitHub"));
	},
	listPulls: async () => [],
	getDeviceAuth: () => {
		authReads += 1;
		return authReads === 1
			? Promise.resolve(pendingAuth)
			: new Promise<DeviceAuthStatus>((resolve) => {
					authCalls.push(resolve);
				});
	},
}));

const { App: SecurityApp } = await import(
	"../../../apps-store/security/ui/src/App.tsx"
);
const { App: PullRequestsApp } = await import(
	"../../../apps-store/pull-requests/ui/src/App.tsx"
);
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
const originalWindowSetInterval = window.setInterval;
const originalWindowClearInterval = window.clearInterval;
const intervals = new Map<number, () => void>();
let timerId = 0;
const captureInterval = (callback: () => void) => {
	timerId += 1;
	intervals.set(timerId, callback);
	return timerId;
};
const clearCapturedInterval = (id: number) => intervals.delete(id);
Reflect.set(globalThis, "setInterval", captureInterval);
Reflect.set(globalThis, "clearInterval", clearCapturedInterval);
Reflect.set(window, "setInterval", captureInterval);
Reflect.set(window, "clearInterval", clearCapturedInterval);
const originalVisibility = Object.getOwnPropertyDescriptor(
	document,
	"visibilityState"
);
let root: Root;
let container: HTMLDivElement;

async function visible(value: boolean) {
	await act(async () => {
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			value: value ? "visible" : "hidden",
		});
		document.dispatchEvent(new Event("visibilitychange"));
	});
}
async function tick(times = 1) {
	await act(async () => {
		for (let i = 0; i < times; i += 1) {
			for (const callback of Array.from(intervals.values())) {
				callback();
			}
		}
	});
}
async function mountPullRequests() {
	await act(async () => root.render(<PullRequestsApp />));
	// The inbox deliberately debounces its initial load by 180 ms.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 220));
	});
}
beforeEach(() => {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	authReads = 0;
	statusReads = 0;
	authenticated = false;
	scanCalls.length = 0;
	authCalls.length = 0;
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	intervals.clear();
});
afterAll(() => {
	Reflect.set(globalThis, "setInterval", originalSetInterval);
	Reflect.set(globalThis, "clearInterval", originalClearInterval);
	Reflect.set(window, "setInterval", originalWindowSetInterval);
	Reflect.set(window, "clearInterval", originalWindowClearInterval);
	if (originalVisibility) {
		Object.defineProperty(document, "visibilityState", originalVisibility);
	} else {
		Reflect.deleteProperty(document, "visibilityState");
	}
});

test("Security pauses hidden scans and keeps only one slow scan poll in flight", async () => {
	await visible(false);
	await act(async () => root.render(<SecurityApp />));
	await tick(10);
	expect(scanCalls).toHaveLength(0);
	await visible(true);
	expect(scanCalls).toHaveLength(1);
	await tick(10);
	expect(scanCalls).toHaveLength(1);
	await act(async () =>
		scanCalls[0]({ scan: { ...scan, progress: 20 }, findings: [] })
	);
	await tick();
	expect(scanCalls).toHaveLength(2);
	await visible(false);
	await act(async () =>
		scanCalls[1]({ scan: { ...scan, progress: 30 }, findings: [] })
	);
	await tick(10);
	expect(scanCalls).toHaveLength(2);
	await visible(true);
	expect(scanCalls).toHaveLength(3);
	await act(async () => root.render(null));
	await act(async () =>
		scanCalls[2]({ scan: { ...scan, status: "completed" }, findings: [] })
	);
	await visible(false);
	await visible(true);
	await tick(10);
	expect(scanCalls).toHaveLength(3);
	expect(intervals.size).toBe(0);
});

test("GitHub auth pauses hidden polls, prevents overlap and ignores late success after cleanup", async () => {
	await visible(false);
	await mountPullRequests();
	expect(authReads).toBe(1); // Initial setup read, separate from periodic polling.
	await tick(10);
	expect(authCalls).toHaveLength(0);
	await visible(true);
	expect(authCalls).toHaveLength(1);
	await tick(10);
	expect(authCalls).toHaveLength(1);
	await act(async () => authCalls[0](pendingAuth));
	await tick();
	expect(authCalls).toHaveLength(2);
	await act(async () => root.render(null));
	await act(async () => authCalls[1]({ ...pendingAuth, state: "success" }));
	await visible(false);
	await visible(true);
	await tick(10);
	expect(authCalls).toHaveLength(2);
	expect(statusReads).toBe(1);
	expect(intervals.size).toBe(0);
});

test("GitHub auth success refreshes the app once and stops polling", async () => {
	await visible(true);
	await mountPullRequests();
	await tick();
	expect(authCalls).toHaveLength(1);
	authenticated = true;
	await act(async () => authCalls[0]({ ...pendingAuth, state: "success" }));
	expect(statusReads).toBe(2);
	await tick(10);
	expect(authCalls).toHaveLength(1);
	expect(intervals.size).toBe(0);
});
