// `useNodeOnline`: native `test_node` decides online/offline, the value is
// `null` until the first answer, and without the Tauri bridge (or for a managed
// cloud computer) the probe falls back to Core's `/api/health`.
import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";

const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
globalThis.fetch = nativeFetch;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { probeNodeOnline, useNodeOnline } = await import("./useNodeOnline.ts");

let healthy = true;
const healthHits: string[] = [];
const server: Bun.Server<undefined> = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: (request: Request): Response => {
		const url = new URL(request.url);
		healthHits.push(url.pathname);
		return healthy
			? NativeResponse.json({ status: "ok" })
			: NativeResponse.json({}, { status: 503 });
	},
});
const node = (name: string, managed = false) => ({
	name,
	url: `${server.url.origin}/${name}`,
	token: null,
	managed,
});

const invocations: { command: string; args: unknown }[] = [];
function installBridge(answer: (name: string) => Promise<boolean>) {
	Reflect.set(window, "__TAURI_INTERNALS__", {
		invoke: async (command: string, args: { name: string }) => {
			invocations.push({ command, args });
			return { online: await answer(args.name) };
		},
		transformCallback: () => 0,
	});
}

afterEach(() => {
	Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
	invocations.length = 0;
	healthHits.length = 0;
	healthy = true;
});
afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
});

test("native test_node true/false maps to online/offline", async () => {
	installBridge(async (name) => name === "up");
	expect(await probeNodeOnline(node("up"))).toBe(true);
	expect(await probeNodeOnline(node("down"))).toBe(false);
	expect(invocations.map((call) => call.command)).toEqual([
		"test_node",
		"test_node",
	]);
	expect(healthHits).toEqual([]);
});

test("a managed computer is probed through /api/health", async () => {
	installBridge(async () => false);
	expect(await probeNodeOnline(node("cloud", true))).toBe(true);
	// The HTTP client may read the auth store through the bridge; what matters
	// is that the native `test_node` probe is never used for a managed computer.
	expect(invocations.filter((call) => call.command === "test_node")).toEqual(
		[]
	);
	expect(healthHits).toEqual(["/cloud/api/health"]);
});

test("without the Tauri bridge the probe falls back to /api/health", async () => {
	expect(await probeNodeOnline(node("web"))).toBe(true);
	healthy = false;
	expect(await probeNodeOnline(node("web"))).toBe(false);
	expect(healthHits).toEqual(["/web/api/health", "/web/api/health"]);
}, 10_000);

test("the hook is null until the first answer", async () => {
	let resolveProbe: ((online: boolean) => void) | undefined;
	installBridge(
		() =>
			new Promise<boolean>((resolve) => {
				resolveProbe = resolve;
			})
	);
	const values: (boolean | null)[] = [];
	function Probe() {
		values.push(useNodeOnline(node("studio")));
		return null;
	}
	const client = new QueryClient();
	const root = createRoot(document.createElement("div"));
	try {
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<Probe />
				</QueryClientProvider>
			)
		);
		expect(values.at(-1)).toBeNull();
		await act(async () => {
			resolveProbe?.(true);
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
		expect(values.at(-1)).toBe(true);
	} finally {
		await act(async () => root.unmount());
		client.clear();
	}
});
