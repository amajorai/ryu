import { afterAll, beforeEach, expect, test } from "bun:test";
import {
	createOpenExternalAsk,
	type ExternalDestination,
} from "@ryu/app-host/open-external-gate";
import { CodedRpcError, dispatchRpc } from "@ryu/app-host/rpc";
import type { PluginHostServicesContext } from "./PluginHostPanel-services-context.ts";
import { buildPluginHostCoreServices } from "./PluginHostPanel-services-core.ts";

// `ui.openExternal` needs no grant, so a Companion frame with an EMPTY granted
// set reaches the Tauri `open_external` command. The command must not be
// invoked until the person says yes to the shell's own prompt.

// The Tauri bridge as the webview injects it: every native command the shell
// invokes lands here.
const invoked: Array<{ args: unknown; command: string }> = [];
const hadWindow = Reflect.has(globalThis, "window");
const shellWindow: object = hadWindow ? Reflect.get(globalThis, "window") : {};
if (!hadWindow) {
	Reflect.set(globalThis, "window", shellWindow);
}
const earlierBridge: unknown = Reflect.get(shellWindow, "__TAURI_INTERNALS__");
Reflect.set(shellWindow, "__TAURI_INTERNALS__", {
	invoke: (command: string, args: unknown) => {
		invoked.push({ args, command });
		return Promise.resolve(null);
	},
	transformCallback: () => 0,
});
afterAll(() => {
	if (hadWindow) {
		Reflect.set(shellWindow, "__TAURI_INTERNALS__", earlierBridge);
	} else {
		Reflect.deleteProperty(globalThis, "window");
	}
});
beforeEach(() => {
	invoked.length = 0;
});

const node = {
	url: "http://127.0.0.1:9/node",
	token: "fixture-node-token",
	userJwt: null,
};

/** The Companion tab's services, with a prompt the test answers by hand. */
function companionServices() {
	const shown: ExternalDestination[] = [];
	const answers: Array<(accepted: boolean) => void> = [];
	const context = {
		askOpenExternal: createOpenExternalAsk({
			confirm: (destination) => {
				shown.push(destination);
				return new Promise<boolean>((resolve) => {
					answers.push(resolve);
				});
			},
			lock: { open: false },
		}),
		assistantContextRef: { current: [] },
		assistantOwner: "plugin:com.example.evil",
		assistantSurfaceRef: { current: null },
		companion: { pluginId: "com.example.evil", name: "Evil App" },
		fileAccess: undefined,
		getActiveNode: () => node,
		i18n: { locale: "en" },
		isActiveTabRef: { current: true },
		node,
		onRequestClose: undefined,
		toastHost: {},
	} as unknown as PluginHostServicesContext;
	return { answers, services: buildPluginHostCoreServices(context), shown };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const opens = () =>
	invoked.filter(({ command }) => command === "open_external");

test("a Companion with no grants does not reach open_external until the person accepts", async () => {
	const { answers, services, shown } = companionServices();
	const call = dispatchRpc(
		"ui.openExternal",
		["https://example.com/c?d=1"],
		new Set(),
		services
	);
	await settle();
	expect(opens()).toEqual([]);
	expect(shown.map((destination) => destination.display)).toEqual([
		"https://example.com/c?d=1",
	]);
	answers[0]?.(true);
	await call;
	expect(opens()).toEqual([
		{ args: { url: "https://example.com/c?d=1" }, command: "open_external" },
	]);
});

test("declining the prompt never reaches open_external and the call is denied", async () => {
	const { answers, services } = companionServices();
	const call = dispatchRpc(
		"ui.openExternal",
		[{ href: "https://example.com/c?d=1" }],
		new Set(),
		services
	).then(
		() => "resolved",
		(error: unknown) =>
			error instanceof CodedRpcError ? error.code : "not coded"
	);
	await settle();
	answers[0]?.(false);
	expect(await call).toBe("denied");
	await settle();
	expect(opens()).toEqual([]);
});

test("open_external receives the address the prompt showed, not the string the service was given", async () => {
	const { answers, services, shown } = companionServices();
	// The service itself, as the RPC gate calls it, with a string no parser has
	// rewritten yet. The URL parser drops the leading space and reads the
	// backslash as a slash, so the host is example.com and the rest is a path.
	const call = services.openExternal?.({
		href: " https://example.com\\@evil.example/c?d=1",
	});
	await settle();
	expect(opens()).toEqual([]);
	expect(shown.map((destination) => destination.host)).toEqual(["example.com"]);
	answers[0]?.(true);
	await call;
	expect(opens()).toEqual([
		{
			args: { url: "https://example.com/@evil.example/c?d=1" },
			command: "open_external",
		},
	]);
});
