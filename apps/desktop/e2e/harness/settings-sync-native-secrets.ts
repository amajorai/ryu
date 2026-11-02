// The desktop's sealed `desktop_secret_*` slots for the settings sync proof
// (src-tauri/src/secrets.rs). Since the vault left plaintext localStorage, the
// auth client (lib/auth-client.ts) keeps the active account in memory and
// seals the vault in the `auth-vault` slot; another window follows a switch
// through the `desktop-secret-changed` event the app emits to every window.
//
// The slot record lives in the owned native host (port 5607), so every window
// of the browser context reads the same sealed vault, and survives reloads. A
// BroadcastChannel carries the change event between those windows, the way
// Tauri's `app.emit` reaches every webview (the writer included). Import this
// module before anything that loads the auth client: the vault hydrates while
// that module evaluates.
import { answerEmptyLegacyAuthStore } from "./desktop-secret-slots.ts";
import { otherProofNode, proofNode } from "./settings-sync-proof-nodes.ts";

const HOST = "http://127.0.0.1:5607";
const CHANGED_EVENT = "desktop-secret-changed";
const nativeFetch = window.fetch.bind(window);
const channel = new BroadcastChannel("settings-sync-proof-desktop-secret");
const callbacks = new Map<number, (event: unknown) => void>();
const listeners = new Map<number, { event: string; handler: number }>();
/** Native commands this proof does not model; the spec ledger expects none. */
const undeclared: string[] = [];
let defaultNode = proofNode.name;
let nextCallback = 1;
let nextEvent = 1;

function emitChanged(name: string) {
	for (const [id, listener] of listeners) {
		if (listener.event === CHANGED_EVENT) {
			callbacks.get(listener.handler)?.({
				event: CHANGED_EVENT,
				id,
				payload: name,
			});
		}
	}
}
channel.onmessage = (message: MessageEvent<string>) =>
	emitChanged(message.data);

async function slot(
	method: "GET" | "PUT" | "DELETE",
	name: unknown,
	value?: unknown
): Promise<string | null> {
	if (typeof name !== "string") {
		throw new Error("Secret slot name required");
	}
	const response = await nativeFetch(
		`${HOST}/native/desktop-secret/${encodeURIComponent(name)}`,
		{
			method,
			headers: { "content-type": "application/json" },
			body: method === "PUT" ? JSON.stringify({ value }) : undefined,
		}
	);
	const body: unknown = await response.json();
	if (!response.ok) {
		throw new Error(`Secret slot ${method} ${name} refused`);
	}
	const stored =
		body && typeof body === "object" ? Reflect.get(body, "value") : undefined;
	return typeof stored === "string" ? stored : null;
}

async function invoke(
	command: string,
	args: Record<string, unknown> = {}
): Promise<unknown> {
	if (command === "desktop_secret_get") {
		return await slot("GET", args.name);
	}
	if (command === "desktop_secret_set" || command === "desktop_secret_delete") {
		await slot(
			command === "desktop_secret_set" ? "PUT" : "DELETE",
			args.name,
			args.value
		);
		const name = String(args.name);
		emitChanged(name);
		channel.postMessage(name);
		return null;
	}
	// The native node registry: an account switch re-reads it (useNodeStore
	// resetNodeStateForIdentityChange), and it lists the same two Cores.
	if (command === "list_nodes") {
		return { default: defaultNode, nodes: [proofNode, otherProofNode] };
	}
	if (command === "set_default_node") {
		defaultNode = String(args.name);
		return null;
	}
	if (command === "plugin:event|listen") {
		const id = nextEvent++;
		listeners.set(id, {
			event: String(args.event),
			handler: Number(args.handler),
		});
		return id;
	}
	if (command === "plugin:event|unlisten") {
		listeners.delete(Number(args.eventId));
		return null;
	}
	const legacy = answerEmptyLegacyAuthStore(command, args);
	if (legacy.handled) {
		return legacy.value;
	}
	undeclared.push(command);
	throw new Error(`Undeclared native command ${command}`);
}

Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
	configurable: true,
	value: {
		unregisterListener: (_event: string, eventId: number) => {
			listeners.delete(eventId);
		},
	},
});
Object.defineProperty(window, "__TAURI_INTERNALS__", {
	configurable: true,
	value: {
		metadata: {
			currentWindow: { label: "main" },
			currentWebview: { label: "main" },
		},
		transformCallback: (callback: (event: unknown) => void) => {
			const id = nextCallback++;
			callbacks.set(id, callback);
			return id;
		},
		unregisterCallback: (id: number) => {
			callbacks.delete(id);
		},
		invoke: (command: string, args?: Record<string, unknown>) =>
			invoke(command, args),
	},
});

/** Read-only proof hooks over the sealed vault and the native boundary. */
const nativeSecretProof = {
	/** The bearer of the vault's active account, as the sealed slot holds it. */
	sealedActiveToken: async (): Promise<string | null> => {
		const raw = await slot("GET", "auth-vault");
		if (!raw) {
			return null;
		}
		const vault = JSON.parse(raw) as {
			accounts: { token: string; userId: string }[];
			activeUserId: string | null;
		};
		return (
			vault.accounts.find((account) => account.userId === vault.activeUserId)
				?.token ?? null
		);
	},
	undeclared: () => [...undeclared],
};
Object.assign(window, { __nativeSecretProof: nativeSecretProof });
