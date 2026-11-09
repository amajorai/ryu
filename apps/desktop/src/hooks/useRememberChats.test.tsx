import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// Keep Bun's own network stack across DOM registration: the hook talks to a
// real HTTP peer below, not a mocked API module.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
globalThis.fetch = nativeFetch;
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { useRememberChats } = await import("./useRememberChats.ts");
type RememberChatsState = ReturnType<typeof useRememberChats>;

const node = { failRead: false, failWrite: false, value: "false" };

const core = Bun.serve({
	port: 0,
	async fetch(request) {
		const { pathname } = new URL(request.url);
		if (pathname !== "/api/preferences/chat-memory-enabled") {
			return new NativeResponse("not found", { status: 404 });
		}
		if (request.method === "PUT") {
			if (node.failWrite) {
				return new NativeResponse("unavailable", { status: 503 });
			}
			node.value = ((await request.json()) as { value: string }).value;
			return NativeResponse.json({ success: true });
		}
		if (node.failRead) {
			return new NativeResponse("unavailable", { status: 503 });
		}
		return NativeResponse.json({ value: node.value });
	},
});

afterAll(() => {
	core.stop(true);
});

const target = { token: null, url: core.url.origin };
const states: Record<string, RememberChatsState> = {};

function Probe({ name }: { name: string }) {
	states[name] = useRememberChats(target);
	return null;
}

async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50 && !check(); attempt += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
	}
}

describe("useRememberChats", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		node.failRead = false;
		node.failWrite = false;
		node.value = "false";
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
	});

	async function mount(...names: string[]): Promise<void> {
		await act(async () => {
			root.render(names.map((name) => <Probe key={name} name={name} />));
		});
		await waitFor(() => names.every((name) => states[name]?.loading === false));
	}

	it("loads the saved opt-in and keeps every mounted control in step", async () => {
		node.value = "false";
		await mount("switch", "prompt");
		expect(states.switch?.enabled).toBe(false);
		expect(states.prompt?.enabled).toBe(false);

		let saved = false;
		await act(async () => {
			saved = (await states.prompt?.setEnabled(true)) ?? false;
		});
		expect(saved).toBe(true);
		expect(node.value).toBe("true");
		expect(states.prompt?.enabled).toBe(true);
		expect(states.switch?.enabled).toBe(true);
	});

	it("reports a load failure without inventing a value", async () => {
		node.failRead = true;
		await mount("switch");
		expect(states.switch?.enabled).toBe(null);
		expect(states.switch?.error).toBe("load");
	});

	it("reloads a value another client changed", async () => {
		node.value = "true";
		await mount("switch");
		expect(states.switch?.enabled).toBe(true);

		// Turned off elsewhere: this window hears nothing until it asks again.
		node.value = "false";
		let read = null as boolean | null;
		await act(async () => {
			read = (await states.switch?.reload()) ?? null;
		});
		expect(read).toBe(false);
		expect(states.switch?.enabled).toBe(false);

		node.failRead = true;
		await act(async () => {
			read = (await states.switch?.reload()) ?? null;
		});
		expect(read).toBe(null);
		expect(states.switch?.enabled).toBe(false);
		expect(states.switch?.error).toBe("load");
	});

	it("keeps the old value and reports a failed save", async () => {
		await mount("switch");
		node.failWrite = true;

		let saved = true;
		await act(async () => {
			saved = (await states.switch?.setEnabled(true)) ?? true;
		});
		expect(saved).toBe(false);
		expect(states.switch?.enabled).toBe(false);
		expect(states.switch?.error).toBe("save");
		expect(states.switch?.saving).toBe(false);
	});
});
