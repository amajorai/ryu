import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ApiTarget } from "@/src/lib/api/client.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
type Children = import("react").ReactNode;
let node: ApiTarget = { url: "https://old-node.test", token: "old-token" };
mock.module("@/lib/auth-client.ts", () => ({
	TOKEN_KEY: "ryu_session_token",
	getActiveToken: () =>
		globalThis.localStorage?.getItem("ryu_session_token") ?? null,
}));
mock.module("@/src/lib/realtime/jwt.ts", () => ({
	getRealtimeJwt: () => null,
}));
mock.module("@/src/store/useNodeStore.ts", () => ({
	useNodeStore: <TResult,>(
		select: (state: { getActiveNode: () => ApiTarget }) => TResult
	) => select({ getActiveNode: () => node }),
}));

// Keep the production caller and HTTP/store contracts real. Replace only the
// portal/menu presentation so source enumeration can be driven deterministically
// without depending on Happy DOM's pointer capture or popover positioning.
mock.module("@ryu/ui/components/dropdown-menu", () => ({
	DropdownMenu: ({
		children,
		onOpenChange,
	}: {
		children: Children;
		onOpenChange: (open: boolean) => void;
	}) =>
		createElement(
			"div",
			null,
			createElement(
				"button",
				{ onClick: () => onOpenChange(true) },
				"Open sources"
			),
			createElement(
				"button",
				{ onClick: () => onOpenChange(false) },
				"Close sources"
			),
			children
		),
	DropdownMenuTrigger: () => null,
	DropdownMenuContent: ({ children }: { children: Children }) =>
		createElement("div", null, children),
	DropdownMenuGroup: ({ children }: { children: Children }) =>
		createElement("div", null, children),
	DropdownMenuLabel: ({ children }: { children: Children }) =>
		createElement("div", null, children),
	DropdownMenuSeparator: () => null,
	DropdownMenuItem: ({
		children,
		onClick,
	}: {
		children: Children;
		onClick?: () => void;
	}) => createElement("button", { onClick }, children),
}));
const { RecordingControls } = await import("./RecordingControls.tsx");
const { useClipStore } = await import("@/src/store/useClipStore.ts");
const originalFetch = globalThis.fetch;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const handoff = mock(() => undefined);
const requests: Array<{
	url: string;
	init?: RequestInit;
	finish: (value: Response) => void;
}> = [];

async function render() {
	await act(async () =>
		root.render(createElement(RecordingControls, { onClipReady: handoff }))
	);
}
async function click(label: string) {
	const button = Array.from(container.querySelectorAll("button")).find(
		(element) =>
			element.textContent === label ||
			element.getAttribute("aria-label") === label
	);
	if (!button) {
		throw new Error(`Missing button: ${label}`);
	}
	await act(async () => button.click());
}
async function reply<TBody>(index: number, body: TBody) {
	await act(async () => {
		requests[index].finish(Response.json(body));
		await Promise.resolve();
	});
}
beforeEach(async () => {
	node = { url: "https://old-node.test", token: "old-token" };
	requests.length = 0;
	handoff.mockClear();
	useClipStore.getState().resetRecording();
	useClipStore.setState({
		captureTarget: { kind: "screen" },
		lastContext: null,
	});
	globalThis.fetch = Object.assign(
		mock(
			(input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((finish) =>
					requests.push({ url: String(input), init, finish })
				)
		),
		{ preconnect: originalFetch.preconnect }
	);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await render();
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	globalThis.fetch = originalFetch;
	useClipStore.getState().resetRecording();
});

for (const change of ["node", "credentials"] as const) {
	test(`capture source response from previous ${change} cannot replace current picker or seed recording`, async () => {
		await click("Open sources");
		expect(requests).toHaveLength(1);
		node =
			change === "node"
				? { url: "https://new-node.test", token: "new-token" }
				: { ...node, token: "new-token", userJwt: "new-delegation" };
		await render();
		await click("Open sources");
		expect(requests).toHaveLength(2);
		expect(requests[1].url).toBe(`${node.url}/api/clips/sources`);
		expect(new Headers(requests[1].init?.headers).get("authorization")).toBe(
			"Bearer new-token"
		);
		await reply(1, {
			displays: [],
			windows: [{ id: 22, title: "Current private window" }],
		});
		await reply(0, {
			displays: [],
			windows: [{ id: 11, title: "Previous private window" }],
		});
		expect(container.textContent).toContain("Current private window");
		expect(container.textContent).not.toContain("Previous private window");
		await click("Current private window");
		await click("Start recording");
		expect(requests).toHaveLength(3);
		expect(requests[2].url).toBe(`${node.url}/api/clips/start`);
		expect(JSON.parse(String(requests[2].init?.body)).target).toEqual({
			kind: "window",
			windowId: 22,
		});
		await reply(2, { available: false, reason: "permission denied" });
		expect(handoff).not.toHaveBeenCalled();
	});
}

const startedClip = {
	id: "clip-1",
	durationMs: 0,
	capture: { screen: true, mic: true, systemAudio: false },
	createdAt: "2026-10-05T00:00:00.000Z",
	diagnosticsPath: "/fixture/clip-1/diagnostics.json",
	framesEndpoint: "/api/clips/clip-1/frame",
	recommendedMoments: [],
	t0EpochMs: 1_791_158_400_000,
	title: "Recording fixture",
	transcriptPath: "/fixture/clip-1/transcript.json",
	video: "/fixture/clip-1/video.mp4",
};

async function startRecording() {
	await click("Start recording");
	await reply(0, startedClip);
}

test("remounting the controls keeps an active recording stoppable", async () => {
	await startRecording();
	expect(useClipStore.getState().clipId).toBe("clip-1");
	await act(async () => root.unmount());
	root = createRoot(container);
	await render();
	expect(useClipStore.getState()).toMatchObject({
		status: "recording",
		clipId: "clip-1",
	});
	await click("Stop recording");
	expect(requests).toHaveLength(2);
	expect(requests[1].url).toBe("https://old-node.test/api/clips/clip-1/stop");
});

test("a new node object with the same credentials does not reset the recording", async () => {
	await startRecording();
	expect(useClipStore.getState().clipId).toBe("clip-1");
	node = { ...node };
	await render();
	expect(useClipStore.getState()).toMatchObject({
		status: "recording",
		clipId: "clip-1",
	});
	expect(
		container.querySelector('[aria-label="Stop recording"]')
	).not.toBeNull();
});

test("switching credentials mid-recording stops the clip on the node that owns it", async () => {
	await startRecording();
	expect(useClipStore.getState().clipId).toBe("clip-1");
	node = { url: "https://new-node.test", token: "new-token" };
	await render();
	expect(useClipStore.getState()).toMatchObject({
		status: "idle",
		clipId: null,
	});
	expect(requests).toHaveLength(2);
	expect(requests[1].url).toBe("https://old-node.test/api/clips/clip-1/stop");
	expect(new Headers(requests[1].init?.headers).get("authorization")).toBe(
		"Bearer old-token"
	);
});

function base64UrlJson(value: unknown): string {
	return btoa(JSON.stringify(value))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

/** A delegation shaped like the control plane's: stable identity claims plus a
 * per-mint `jti`/`iat`/`exp`, so two mints for one user differ byte-for-byte. */
function delegation(subject: string, mint: number): string {
	const header = base64UrlJson({ alg: "EdDSA", typ: "JWT" });
	const claims = base64UrlJson({
		iss: "https://control.test",
		sub: subject,
		org_id: "org-1",
		node_id: "node-1",
		jti: `mint-${mint}`,
		iat: 1_791_158_400 + mint,
		exp: 1_791_159_120 + mint,
	});
	return `${header}.${claims}.signature-${mint}`;
}

test("a rotated managed-node delegation keeps the recording and stops with the fresh credential", async () => {
	node = {
		url: "https://old-node.test",
		token: null,
		userJwt: delegation("user-1", 1),
	};
	await render();
	await startRecording();
	expect(useClipStore.getState().clipId).toBe("clip-1");
	// refreshCloudTokens on window focus re-mints the delegation.
	const fresh = delegation("user-1", 2);
	node = { ...node, userJwt: fresh };
	await render();
	expect(useClipStore.getState()).toMatchObject({
		status: "recording",
		clipId: "clip-1",
	});
	expect(requests).toHaveLength(1);
	await click("Stop recording");
	expect(requests).toHaveLength(2);
	expect(requests[1].url).toBe("https://old-node.test/api/clips/clip-1/stop");
	expect(new Headers(requests[1].init?.headers).get("authorization")).toBe(
		`Bearer ${fresh}`
	);
});

test("a delegation for a different user on the same node abandons the recording", async () => {
	const original = delegation("user-1", 1);
	node = { url: "https://old-node.test", token: null, userJwt: original };
	await render();
	await startRecording();
	node = { ...node, userJwt: delegation("user-2", 2) };
	await render();
	expect(useClipStore.getState()).toMatchObject({
		status: "idle",
		clipId: null,
	});
	expect(requests).toHaveLength(2);
	expect(requests[1].url).toBe("https://old-node.test/api/clips/clip-1/stop");
	expect(new Headers(requests[1].init?.headers).get("authorization")).toBe(
		`Bearer ${original}`
	);
});

test("a scope change while the controls are unmounted still stops the clip on its node", async () => {
	await startRecording();
	await act(async () => root.unmount());
	node = { url: "https://new-node.test", token: "new-token" };
	root = createRoot(container);
	await render();
	expect(useClipStore.getState()).toMatchObject({
		status: "idle",
		clipId: null,
	});
	expect(requests).toHaveLength(2);
	expect(requests[1].url).toBe("https://old-node.test/api/clips/clip-1/stop");
	expect(new Headers(requests[1].init?.headers).get("authorization")).toBe(
		"Bearer old-token"
	);
});

test("superseded enumeration failure cannot publish an error or finish the current retry", async () => {
	await click("Open sources");
	await click("Close sources");
	await click("Open sources");
	expect(requests).toHaveLength(2);
	await reply(0, {
		available: false,
		reason: "Previous request permission denied",
	});
	expect(container.querySelector('[role="alert"]')).toBeNull();
	expect(container.textContent).toContain("Loading capture sources…");
	await reply(1, {
		displays: [],
		windows: [{ id: 44, title: "Retry private window" }],
	});
	expect(container.textContent).not.toContain("Loading capture sources…");
	expect(container.textContent).toContain("Retry private window");
	expect(handoff).not.toHaveBeenCalled();
});

test("capture permission refusal remains actionable and reopening retries with current credentials", async () => {
	await click("Open sources");
	await reply(0, {
		available: false,
		reason: "Screen recording permission denied",
	});
	expect(container.querySelector('[role="alert"]')?.textContent).toContain(
		"Screen recording permission denied"
	);
	expect(container.textContent).toContain("Close and reopen to retry");
	expect(handoff).not.toHaveBeenCalled();
	await click("Close sources");
	await click("Open sources");
	expect(requests).toHaveLength(2);
	expect(requests.map((request) => request.url)).toEqual([
		"https://old-node.test/api/clips/sources",
		"https://old-node.test/api/clips/sources",
	]);
	await reply(1, {
		displays: [],
		windows: [{ id: 33, title: "Permission granted window" }],
	});
	expect(container.querySelector('[role="alert"]')).toBeNull();
	await click("Permission granted window");
	await click("Start recording");
	expect(JSON.parse(String(requests[2].init?.body)).target).toEqual({
		kind: "window",
		windowId: 33,
	});
	expect(new Headers(requests[2].init?.headers).get("authorization")).toBe(
		"Bearer old-token"
	);
	await reply(2, { available: false, reason: "Capture service busy" });
	expect(useClipStore.getState().captureTarget).toEqual({
		kind: "window",
		windowId: 33,
	});
	expect(handoff).not.toHaveBeenCalled();
});
