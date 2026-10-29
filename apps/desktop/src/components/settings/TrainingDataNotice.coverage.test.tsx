import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import {
	button,
	click,
	flush,
	installNativeBridge,
	type NativeCall,
	normalized,
	registerDomWithNativeNetworking,
	until,
} from "./unswept-b.test-support.ts";

// Coverage for `TrainingDataNotice`, the "Train on my data" card that General
// and Privacy settings both render. Its three controls hand a URL to the
// native shell (`open_external`), so the effect asserted here is the exact
// command and URL that reach the recorded Tauri IPC boundary, on the frontend
// origin this build was configured with, and that a native refusal or a
// missing bridge never escapes as an unhandled rejection.
const FRONTEND = "https://ryu-frontend.unswept-b.test";
process.env.VITE_APP_FRONTEND_URL = FRONTEND;
registerDomWithNativeNetworking();

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TrainingDataNotice } = await import("./TrainingDataNotice.tsx");

type Root = ReturnType<typeof createRoot>;

const runtimeErrors: string[] = [];
const onRejection = (event: PromiseRejectionEvent) =>
	runtimeErrors.push(String(event.reason));
const onError = (event: ErrorEvent) => runtimeErrors.push(event.message);
const onProcessRejection = (reason: unknown) =>
	runtimeErrors.push(`process: ${String(reason)}`);
process.on("unhandledRejection", onProcessRejection);

let root: Root | null = null;
let bridge: ReturnType<typeof installNativeBridge> | null = null;

beforeEach(async () => {
	runtimeErrors.length = 0;
	window.addEventListener("unhandledrejection", onRejection);
	window.addEventListener("error", onError);
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container, {
		onCaughtError: (error) => runtimeErrors.push(String(error)),
		onUncaughtError: (error) => runtimeErrors.push(String(error)),
	});
});

afterEach(async () => {
	const mounted = root;
	root = null;
	await act(async () => mounted?.unmount());
	bridge?.uninstall();
	bridge = null;
	await flush(2);
	window.removeEventListener("unhandledrejection", onRejection);
	window.removeEventListener("error", onError);
	document.body.replaceChildren();
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must leave no unhandled rejection or render error behind.
	expect(runtimeErrors).toEqual([]);
});

afterAll(() => {
	process.off("unhandledRejection", onProcessRejection);
});

async function mount() {
	await act(async () => root?.render(<TrainingDataNotice />));
}

/**
 * The URLs the card handed to `open_external`. The only other native traffic
 * allowed is the auth client's own hydration, which importing the frontend
 * origin pulls in: its sealed-slot reads (`desktop_secret_get` of `auth-vault`
 * or `license-key`) and the legacy token store (`plugin:store|*`). Anything else
 * is a failure.
 */
function isAuthHydration(call: NativeCall): boolean {
	if (call.command.startsWith("plugin:store|")) {
		return true;
	}
	const name = (call.args as { name?: unknown } | undefined)?.name;
	return (
		call.command === "desktop_secret_get" &&
		(name === "auth-vault" || name === "license-key")
	);
}

function openExternalUrls(calls: NativeCall[]): unknown[] {
	const foreign = calls.filter(
		(call) => call.command !== "open_external" && !isAuthHydration(call)
	);
	if (foreign.length > 0) {
		throw new Error(`Unexpected native commands: ${JSON.stringify(foreign)}`);
	}
	return calls
		.filter((call) => call.command === "open_external")
		.map((call) => (call.args as { url?: unknown }).url);
}

function opens(): number {
	return bridge ? openExternalUrls(bridge.calls).length : 0;
}

test("GitHub, Privacy and Terms each ask the native shell to open their exact page, once per click, in order", async () => {
	bridge = installNativeBridge();
	await mount();

	const card = document.body;
	expect(normalized(card)).toContain("Train on my data");
	expect(normalized(card)).toContain("We never train on your data.");
	expect(normalized(card)).toContain(
		"Core and Gateway are open source, so you can inspect and verify that promise."
	);

	await click(button("GitHub"));
	await click(button("Privacy"));
	await click(button("Terms"));
	await click(button("Privacy"));
	await until(() => opens() === 4, "four native opens");

	expect(openExternalUrls(bridge.calls)).toEqual([
		"https://github.com/amajorai/ryu",
		`${FRONTEND}/privacy`,
		`${FRONTEND}/terms`,
		`${FRONTEND}/privacy`,
	]);
	// The legal links follow the configured frontend, never a hard-coded host.
	expect(
		openExternalUrls(bridge.calls).filter((url) =>
			String(url).startsWith("http://localhost")
		)
	).toEqual([]);
});

test("a native refusal is contained: the card stays usable and the next click reaches the shell again", async () => {
	bridge = installNativeBridge();
	await mount();
	bridge.failWith("open_external: no default browser");

	await click(button("Terms"));
	await click(button("GitHub"));
	await until(() => opens() === 2, "two refused opens");
	await flush(4);
	expect(openExternalUrls(bridge.calls)).toEqual([
		`${FRONTEND}/terms`,
		"https://github.com/amajorai/ryu",
	]);
	expect(button("Terms").disabled).toBe(false);
	expect(normalized(document.body)).toContain("We never train on your data.");

	bridge.failWith(null);
	await click(button("Privacy"));
	await until(() => opens() === 3, "open after recovery");
	expect(openExternalUrls(bridge.calls).at(-1)).toBe(`${FRONTEND}/privacy`);
});

test("outside the native shell (no Tauri bridge) a click waits out the bridge deadline and fails quietly", async () => {
	await mount();
	await click(button("Privacy"));
	// The shared ready-gate polls for up to two seconds before rejecting with a
	// typed TauriUnavailableError, which the card swallows.
	await act(async () => {
		await Bun.sleep(2300);
	});
	await flush(4);
	expect(button("Privacy").disabled).toBe(false);
	expect(normalized(document.body)).toContain("Train on my data");
});
