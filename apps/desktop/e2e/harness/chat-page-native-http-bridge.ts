// The Tauri IPC bridge of the ChatPage native HTTP harness. A Tauri webview
// injects `window.__TAURI_INTERNALS__` before any page script runs, so the
// harness imports this module first: app modules that invoke a command while
// they load (the auth vault, the sealed localStorage key) then reach the bridge
// exactly as they do in the desktop, instead of racing its installation.
// Only native IPC is replaced; unknown commands are recorded and refused.

import { createChatPageNativeDependencies } from "./chat-page-native-http-dependencies.ts";

const CORE_URL =
	import.meta.env.VITE_CHAT_PAGE_CORE_URL ?? "http://127.0.0.1:5591";
const CORE_TOKEN = "chat-page-native-node-a-token";
// `LOCAL_FALLBACK` (src/store/useNodeStore.ts) with this fixture's Core. Spelled
// out here because importing the store would load app modules first.
export const LOCAL_NODE = {
	name: "local",
	url: CORE_URL,
	token: CORE_TOKEN,
	userJwt: null,
};
export const OTHER_NODE = {
	...LOCAL_NODE,
	id: "native-proof-b",
	name: "Native HTTP B",
	url: "http://127.0.0.1:5594",
	token: "chat-page-native-node-b-token",
};
export const TASK_SUGGESTION_WITH_DRAFTS = [
	"task-suggestion",
	"task-suggestion-agent",
	"task-suggestion-temporary",
];
export const TASK_SUGGESTION_SCENARIOS = [
	...TASK_SUGGESTION_WITH_DRAFTS,
	"task-suggestion-bare",
];
export const scenario =
	new URLSearchParams(location.search).get("scenario") ?? "share";

const nativeDependencies = createChatPageNativeDependencies(localStorage, {
	acceptNewChats: TASK_SUGGESTION_SCENARIOS.includes(scenario),
});

// Match the SDK's callback and listener lifecycle: unlisten first unregisters
// its JS callback through the event-plugin internals, then invokes native cleanup.
const callbacks = new Map<number, (payload: unknown) => void>();
const listeners = new Map<number, { event: string; handler: number }>();
const unexpectedNativeCommands: string[] = [];
const unexpectedNativeDetails: Array<{
	command: string;
	args: unknown;
	error: string;
}> = [];
let nativeDefault =
	sessionStorage.getItem("chat-page-native-default") ?? "local";
let holdNextClipsListener = false;
const heldClipsListeners = new Map<number, (id: number) => void>();
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
		invoke: async (
			command: string,
			args?: {
				event?: string;
				handler?: number;
				eventId?: number;
				name?: string;
				[key: string]: unknown;
			}
		) => {
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
				if (args.event === "clips:quick-attach" && holdNextClipsListener) {
					holdNextClipsListener = false;
					return new Promise<number>((resolve) =>
						heldClipsListeners.set(id, resolve)
					);
				}
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
				return {
					default: nativeDefault,
					nodes: [{ ...LOCAL_NODE }, { ...OTHER_NODE }],
				};
			}
			if (command === "set_default_node") {
				if (
					!args ||
					Object.keys(args).length !== 1 ||
					![LOCAL_NODE.name, OTHER_NODE.name].includes(args.name ?? "")
				) {
					throw new Error("Invalid owned default node");
				}
				nativeDefault = args.name as string;
				sessionStorage.setItem("chat-page-native-default", nativeDefault);
				return null;
			}
			if (command === "local_node_token") {
				return { token: CORE_TOKEN };
			}
			if (command === "test_node") {
				return { online: true };
			}
			try {
				const dependency = nativeDependencies.invoke(command, args);
				if (dependency.handled) {
					return dependency.value;
				}
			} catch (error) {
				unexpectedNativeCommands.push(command);
				unexpectedNativeDetails.push({
					command,
					args: structuredClone(args),
					error: String(error),
				});
				throw error;
			}
			unexpectedNativeCommands.push(command);
			unexpectedNativeDetails.push({
				command,
				args: structuredClone(args),
				error: `Unexpected native command: ${command}`,
			});
			throw new Error(`Unexpected native command: ${command}`);
		},
	},
});

/** The fixture's view of the bridge, for `window.__chatPageNativeFixture`. */
export const nativeBridge = {
	defaultNode: () => nativeDefault,
	snapshot: () => ({
		callbacks: callbacks.size,
		listeners: listeners.size,
		unexpected: [...unexpectedNativeCommands],
	}),
	diagnostics: () => ({
		listeners: [...listeners.entries()].map(([id, listener]) => ({
			id,
			...listener,
		})),
		callbackIds: [...callbacks.keys()],
		heldClipsListenerIds: [...heldClipsListeners.keys()],
		unexpected: structuredClone(unexpectedNativeDetails),
	}),
	holdNextClipsListener: () => {
		if (holdNextClipsListener || heldClipsListeners.size) {
			throw new Error("A native Clips acknowledgment is already held");
		}
		holdNextClipsListener = true;
	},
	releaseClipsListener: (id: number) => {
		const release = heldClipsListeners.get(id);
		if (!release) {
			throw new Error("Unknown held native Clips acknowledgment");
		}
		heldClipsListeners.delete(id);
		release(id);
	},
};
