// Shared by the usePluginShortcutOverrides.http suites: the mounted consumer,
// its teardown, and the helpers the native fixture is built from.
import { afterEach } from "bun:test";
import {
	closeSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

/** Module state other suites' modules write, kept on one shared object. */
export const live = {
	latest: undefined as unknown as ReturnType<typeof usePluginShortcutOverrides>,
	root: undefined as unknown as ReturnType<typeof createRoot> | undefined,
	container: undefined as unknown as HTMLDivElement | undefined,
	dispose: undefined as unknown as (() => Promise<void>) | undefined,
	runtimeErrors: [] as string[],
	fixtureReceiptId: 0,
};

export const nativeFetch = globalThis.fetch;
export const NativeResponse = globalThis.Response;
export const NativeRequest = globalThis.Request;
export const NativeHeaders = globalThis.Headers;
export const NativeAbortController = globalThis.AbortController;
export const NativeAbortSignal = globalThis.AbortSignal;
export const nativeResponseText = NativeResponse.prototype.text;
export const nativeResponseJson = NativeResponse.prototype.json;
export const nativeSetTimeout = globalThis.setTimeout;
export const nativeClearTimeout = globalThis.clearTimeout;
if (typeof document === "undefined") {
	GlobalRegistrator.register();
}
globalThis.fetch = nativeFetch;
globalThis.Response = NativeResponse;
globalThis.Request = NativeRequest;
globalThis.Headers = NativeHeaders;
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
export const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
export const { sileo } = await import("sileo");
export const { usePluginShortcutOverrides } = await import(
	"./usePluginShortcutOverrides.ts"
);
export const { useActiveNode } = await import("./useActiveNode.ts");
export const { toTarget } = await import("../lib/api/client.ts");
export const { useNodeStore } = await import("../store/useNodeStore.ts");
export const { CurrentTabIdProvider } = await import(
	"../contexts/TabsContext.tsx"
);
export const { setNodeTabOverride } = await import("./useNodeDisplayMode.ts");
export const previousTabOverride = localStorage.getItem(
	"ryu_node_tab_override_enabled"
);
export const previousNodes = useNodeStore.getState();
export function Consumer() {
	live.latest = usePluginShortcutOverrides(toTarget(useActiveNode()));
	return createElement(
		"output",
		null,
		JSON.stringify({
			overrides: live.latest.overrides,
			disabled: live.latest.disabled,
			error: live.latest.error,
		})
	);
}
export async function mount(tabId?: string) {
	live.container = document.createElement("div");
	document.body.append(live.container);
	live.root = createRoot(live.container, {
		onCaughtError: (error) => live.runtimeErrors.push(String(error)),
		onUncaughtError: (error) => live.runtimeErrors.push(String(error)),
		onRecoverableError: (error) => live.runtimeErrors.push(String(error)),
	});
	await act(async () =>
		live.root?.render(
			createElement(
				"div",
				null,
				tabId === undefined ? (
					createElement(Consumer)
				) : (
					<CurrentTabIdProvider tabId={tabId}>
						<Consumer />
					</CurrentTabIdProvider>
				),
				createElement(Toaster, { theme: "dark" })
			)
		)
	);
}
export async function settle(predicate: () => boolean) {
	for (let attempt = 0; attempt < 300; attempt += 1) {
		if (predicate()) {
			return;
		}
		await act(async () => {
			await Bun.sleep(10);
		});
	}
	throw new Error(
		"Mounted shortcut consumer did not acknowledge the operation"
	);
}

/** The fsynced JSON shortcut documents of both authorities under `directory`. */
export function shortcutStore(directory: string) {
	const raw = (authority: "a" | "b") =>
		readFileSync(path.join(directory, `${authority}.json`), "utf8");
	const store = (authority: "a" | "b", bytes: string) => {
		const file = path.join(directory, `${authority}.json`);
		writeFileSync(`${file}.new`, bytes);
		// Read-write: Windows refuses to flush a read-only handle (EPERM).
		const fd = openSync(`${file}.new`, "r+");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(`${file}.new`, file);
		// Windows cannot fsync a directory handle (EPERM); NTFS journals the
		// rename, so only POSIX hosts sync the parent directory.
		if (process.platform !== "win32") {
			const parent = openSync(directory, "r");
			try {
				fsyncSync(parent);
			} finally {
				closeSync(parent);
			}
		}
	};
	return { raw, store };
}

/** Why `request` is not the shipping Desktop transport, or null when it is. */
export const validateHeaders = (request: Request): string | null => {
	const clientId = localStorage.getItem("ryu_client_id");
	if (!clientId || request.headers.get("x-ryu-client-id") !== clientId) {
		return "Wrong or missing persisted Desktop client identity";
	}
	if (
		request.headers.get("content-type") !== "application/json" ||
		request.headers.get("x-ryu-client-label") !== "Desktop" ||
		request.headers.get("x-ryu-surface") !== "desktop" ||
		request.headers.has("cookie") ||
		request.headers.has("origin")
	) {
		return "Unexpected native transport or Desktop identity headers";
	}
	const identityNames = [...request.headers.keys()]
		.filter((name) => name.startsWith("x-ryu-"))
		.sort();
	if (
		JSON.stringify(identityNames) !==
		JSON.stringify(["x-ryu-client-id", "x-ryu-client-label", "x-ryu-surface"])
	) {
		return "Undeclared delegation, buyer or attribution header";
	}
	if (
		!["Bearer token-a", "Bearer token-b"].includes(
			request.headers.get("authorization") ?? ""
		)
	) {
		return "Undeclared node admission credential";
	}
	return null;
};

/** Select authority `authority` of the peer at `origin` as the only node. */
export function selectAuthority(origin: string, authority: "a" | "b") {
	const node = {
		name: authority,
		url: `${origin.replace(/\/$/, "")}/${authority}`,
		token: `token-${authority}`,
	};
	useNodeStore.setState({
		nodes: [node],
		localNodes: [node],
		cloudNodes: [],
		defaultNode: authority,
		autoSelect: false,
		autoSelectedNode: null,
		tabOverrides: {},
	});
}

/** The per-test setup and teardown every suite on this harness registers. */
export function registerShortcutOverridesHooks() {
	afterEach(async () => {
		const cleanupErrors: unknown[] = [];
		try {
			await act(async () => live.root?.unmount());
		} catch (error) {
			cleanupErrors.push(error);
		}
		live.root = undefined;
		live.container?.remove();
		live.container = undefined;

		try {
			await live.dispose?.();
		} catch (error) {
			cleanupErrors.push(error);
		} finally {
			live.dispose = undefined;
			sileo.clear();
			useNodeStore.setState(previousNodes);
			if (previousTabOverride === null) {
				localStorage.removeItem("ryu_node_tab_override_enabled");
			} else {
				localStorage.setItem(
					"ryu_node_tab_override_enabled",
					previousTabOverride
				);
			}
			window.dispatchEvent(new Event("storage"));
		}
		if (cleanupErrors.length) {
			throw new AggregateError(
				cleanupErrors,
				"Actual mounted consumer cleanup failed"
			);
		}
	});
}
