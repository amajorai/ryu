import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { OpenedFileAccess } from "@ryu/app-host/opened-file";
import type { HostPush } from "@ryu/app-host/rpc";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useOpenedFilePush } = await import(
	"./PluginHostPanel-opened-file-push.ts"
);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let focused = true;
document.hasFocus = () => focused;
const cleanups: (() => void)[] = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) {
		cleanup();
	}
	focused = true;
});

async function mountPush(revisions: () => string) {
	let reads = 0;
	const pushes: HostPush[] = [];
	const fileAccess: OpenedFileAccess = {
		uri: "host-resource://file",
		name: "deck.pptx",
		editable: false,
		read: () => {
			reads += 1;
			return Promise.resolve({
				uri: "host-resource://file",
				revision: revisions(),
				text: "",
			});
		},
	};
	function Harness() {
		const pushRef = useOpenedFilePush(fileAccess, "nonce", "nonce");
		pushRef.current = (message) => pushes.push(message);
		return null;
	}
	const root = createRoot(document.createElement("div"));
	await act(async () => {
		root.render(createElement(Harness));
		await wait(0);
	});
	cleanups.push(() => act(() => root.unmount()));
	return { pushes, reads: () => reads };
}

test("an unfocused window stops polling the opened file", async () => {
	focused = false;
	const push = await mountPush(() => "r1");
	expect(push.reads()).toBe(1);
	await act(() => wait(1300));
	expect(push.reads()).toBe(1);
});

test("regaining focus refreshes at once and pushes the new revision", async () => {
	focused = false;
	let revision = "r1";
	const push = await mountPush(() => revision);
	revision = "r2";
	focused = true;
	await act(async () => {
		window.dispatchEvent(new Event("focus"));
		await wait(0);
	});
	expect(push.reads()).toBe(2);
	const last = push.pushes.at(-1);
	expect(last?.kind).toBe("ryu-widget-set-globals");
	expect(JSON.stringify(last)).toContain('"revision":"r2"');
});

test("a focused window keeps polling every second", async () => {
	const push = await mountPush(() => "r1");
	await act(() => wait(1100));
	expect(push.reads()).toBe(2);
});
