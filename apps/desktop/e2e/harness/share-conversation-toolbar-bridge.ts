// The Tauri IPC bridge of the share-toolbar / ChatPage control-path harness.
// A Tauri webview injects `window.__TAURI_INTERNALS__` before any page script
// runs, so the entry imports this module first: app modules that invoke a
// command while they load (the auth vault, the sealed localStorage key) reach
// the bridge as they do in the desktop instead of racing its installation.

import { createChatPageNativeDependencies } from "./chat-page-native-http-dependencies.ts";

// `LOCAL_FALLBACK` (src/store/useNodeStore.ts), set by the entry once the app
// modules load; importing the store here would load them before the bridge.
let localNode: Record<string, unknown> | null = null;
export function setToolbarLocalNode(node: Record<string, unknown>) {
	localNode = node;
}

// Match the SDK's callback and listener lifecycle: unlisten first unregisters
// its JS callback through the event-plugin internals, then invokes native cleanup.
const callbacks = new Map<number, (payload: unknown) => void>();
const listeners = new Map<number, { event: string; handler: number }>();
const unexpectedNativeCommands: string[] = [];
const unexpectedNativeDetails: Array<{
	command: string;
	args: unknown;
	message: string;
}> = [];
const nativeDependencies = createChatPageNativeDependencies(localStorage);
let nextCallback = 0;
let nextListener = 0;
Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
	value: {
		unregisterListener: (event: string, id: number) => {
			const listener = listeners.get(id);
			if (listener?.event === event) {
				callbacks.delete(listener.handler);
			}
		},
	},
});
Object.defineProperty(window, "__TAURI_INTERNALS__", {
	value: {
		metadata: {
			currentWindow: { label: "main" },
			currentWebview: { label: "main" },
		},
		transformCallback: (callback: (payload: unknown) => void) => {
			const id = ++nextCallback;
			callbacks.set(id, callback);
			return id;
		},
		unregisterCallback: (id: number) => {
			callbacks.delete(id);
		},
		invoke: async (command: string, args?: Record<string, unknown>) => {
			if (command === "plugin:event|listen") {
				if (
					typeof args?.event !== "string" ||
					typeof args.handler !== "number" ||
					!callbacks.has(args.handler)
				) {
					throw new Error("Invalid native event registration");
				}
				const id = ++nextListener;
				listeners.set(id, { event: args.event, handler: args.handler });
				return id;
			}
			if (command === "plugin:event|unlisten") {
				if (
					typeof args?.eventId !== "number" ||
					(listeners.has(args.eventId) &&
						listeners.get(args.eventId)?.event !== args.event)
				) {
					throw new Error("Invalid native event cleanup");
				}
				listeners.delete(args.eventId);
				return null;
			}
			// The mounted Layout refreshes the native profile and probes this local
			// fixture Core. These are the native DTOs consumed by the real stores.
			if (command === "list_nodes") {
				if (!localNode) {
					throw new Error("The fixture's local node is not set yet");
				}
				return { default: "local", nodes: [{ ...localNode }] };
			}
			if (command === "local_node_token") {
				return { token: null };
			}
			if (command === "test_node") {
				return { online: true };
			}
			try {
				if (command === "get_safe_mode_sentinel") {
					if (Object.keys(args ?? {}).length) {
						throw new Error("Unexpected safe-mode sentinel arguments");
					}
					return false;
				}
				const dependency = nativeDependencies.invoke(command, args);
				if (dependency.handled) {
					return dependency.value;
				}
			} catch (error) {
				unexpectedNativeCommands.push(command);
				unexpectedNativeDetails.push({
					command,
					args: structuredClone(args ?? {}),
					message: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
			unexpectedNativeDetails.push({
				command,
				args: structuredClone(args ?? {}),
				message: `Unexpected native command: ${command}`,
			});
			unexpectedNativeCommands.push(command);
			throw new Error(`Unexpected native command: ${command}`);
		},
	},
});

/** The fixture's view of the bridge, for `window.__shareToolbarFixture`. */
export const toolbarNativeBridge = {
	snapshot: () => ({
		callbacks: callbacks.size,
		listeners: listeners.size,
		unexpected: [...unexpectedNativeCommands],
	}),
	diagnostics: () => ({
		listeners: [...listeners].map(([id, listener]) => ({ id, ...listener })),
		callbackIds: [...callbacks.keys()],
		unexpected: structuredClone(unexpectedNativeDetails),
		heldClipsListenerIds: [] as number[],
	}),
};
