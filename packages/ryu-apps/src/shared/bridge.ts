// The FRAME-SIDE widget runtime (spec §1.2/§1.3, D2, D6).
//
// This runs INSIDE the sandboxed, null-origin widget iframe. It is the mirror of
// the desktop host's `rpc.ts` + `ExtensionHost.tsx`: it establishes the
// `ryu-plugin-ready` / `ryu-plugin-host-port` handshake, then marshals the widget's
// `window.ryu` method calls into `{ kind:"ryu-plugin-rpc", id, method, args }`
// envelopes over the transferred `MessagePort`, and applies host `set-globals`
// pushes back onto `window.ryu`.
//
// Security note: this file holds NO token and reaches the network for NOTHING. All
// egress is an RPC the host grant-gates (see `rpc.ts`). The CSP inside the widget
// document hard-pins `connect-src 'none'` (D3), so the only channel out is the port.
//
// Initial props are injected SYNCHRONOUSLY by the host into `window.ryu` before this
// module evaluates (D2); this bridge MERGES onto them, never clobbers them, and then
// keeps them live via `ryu-widget-set-globals` pushes.

import type {
	RyuWidgetGlobals,
	RyuWidgetProps,
	WidgetDisplayMode,
	WidgetRpcErrorCode,
} from "./window.ryu";

/** Envelope kind: widget → host RPC request (matches `rpc.ts` `RpcRequest`). */
const RPC_REQUEST_KIND = "ryu-plugin-rpc";
/** Envelope kind: host → widget RPC reply (matches `rpc.ts` `RpcResponse`). */
const RPC_RESULT_KIND = "ryu-plugin-rpc-result";
/** Envelope kind: host → widget globals push (partial merge). */
const SET_GLOBALS_KIND = "ryu-widget-set-globals";
/** Envelope kind: widget → parent readiness announce. */
const READY_KIND = "ryu-plugin-ready";
/** Envelope kind: host → widget port transfer, carrying the nonce. */
const HOST_PORT_KIND = "ryu-plugin-host-port";

/** DOM events re-dispatched on every globals change. Both names always fire so an
 *  unmodified `window.openai` component and a native Ryu component both react. */
const RYU_SET_GLOBALS_EVENT = "ryu:set_globals";
const OPENAI_SET_GLOBALS_EVENT = "openai:set_globals";

/** RPC method names (spec §1.2). */
const METHOD_TOOL_CALL = "tool.call";
const METHOD_SEND_MESSAGE = "ui.sendMessage";
const METHOD_SET_STATE = "widget.setState";
const METHOD_GET_GLOBALS = "widget.getGlobals";
const METHOD_REQUEST_DISPLAY_MODE = "ui.requestDisplayMode";
const METHOD_NOTIFY_HEIGHT = "ui.notifyHeight";
const METHOD_REQUEST_CLOSE = "ui.requestClose";
const METHOD_OPEN_EXTERNAL = "ui.openExternal";

/** The default props a widget sees if the host injected nothing synchronously. */
const DEFAULT_PROPS: RyuWidgetProps = {
	toolInput: null,
	toolOutput: null,
	toolResponseMetadata: null,
	widgetState: null,
	theme: "dark",
	locale: "en-US",
	displayMode: "inline",
	maxHeight: null,
	safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
};

/** An error carried back from a rejected host RPC, tagged with the D6 code so a
 *  widget can branch on `denied` vs `over_budget` vs `server_error`, etc. */
export class WidgetRpcError extends Error {
	code: WidgetRpcErrorCode;
	constructor(code: WidgetRpcErrorCode, message: string) {
		super(message);
		this.name = "WidgetRpcError";
		this.code = code;
	}
}

interface PendingCall {
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
}

interface RpcEnvelope {
	kind: typeof RPC_REQUEST_KIND;
	id: number;
	method: string;
	args: unknown[];
}

/** The private runtime state — one per frame, memoized on `window`. */
interface BridgeRuntime {
	port: MessagePort | null;
	nextId: number;
	pending: Map<number, PendingCall>;
	/** Envelopes queued before the port arrived; flushed on connect. */
	outbox: RpcEnvelope[];
	globals: RyuWidgetGlobals;
}

const RUNTIME_KEY = "__ryuBridgeRuntime" as const;

/** Marker the host-injected synchronous bootstrap sets on `window` right after it
 *  installs its authoritative `window.ryu` (see `widget-bootstrap.ts` `bridgeSource`).
 *  It is the SINGLE detection contract shared by both files: when present,
 *  `installRyuBridge` is a NO-OP and returns the bootstrap's live bridge untouched,
 *  so its MessagePort is never nulled and its `window.ryu` is never overwritten. */
const HOST_BRIDGE_KEY = "__ryuHostBridge" as const;

type BridgeWindow = Window & {
	[RUNTIME_KEY]?: BridgeRuntime;
	[HOST_BRIDGE_KEY]?: boolean;
};

/** A `window.ryu` that already exposes a callable `callTool` is a live bridge (the
 *  host bootstrap, or a prior `installRyuBridge`), safe to adopt as-is. */
function isLiveBridge(candidate: unknown): candidate is RyuWidgetGlobals {
	return (
		typeof candidate === "object" &&
		candidate !== null &&
		typeof (candidate as { callTool?: unknown }).callTool === "function"
	);
}

function dispatchSetGlobals(partial: Partial<RyuWidgetProps>): void {
	for (const name of [RYU_SET_GLOBALS_EVENT, OPENAI_SET_GLOBALS_EVENT]) {
		window.dispatchEvent(
			new CustomEvent(name, { detail: { globals: partial } }),
		);
	}
}

function normalizeError(error: unknown): WidgetRpcError {
	if (error && typeof error === "object" && "message" in error) {
		const payload = error as { code?: unknown; message?: unknown };
		const code =
			typeof payload.code === "string"
				? (payload.code as WidgetRpcErrorCode)
				: "server_error";
		return new WidgetRpcError(
			code,
			String(payload.message ?? "widget rpc error"),
		);
	}
	if (typeof error === "string") {
		return new WidgetRpcError("server_error", error);
	}
	return new WidgetRpcError("server_error", "widget rpc error");
}

function flushOutbox(runtime: BridgeRuntime): void {
	if (!runtime.port) {
		return;
	}
	for (const envelope of runtime.outbox) {
		runtime.port.postMessage(envelope);
	}
	runtime.outbox = [];
}

/** Send an RPC and resolve/reject by id. Queues until the port is live so a widget
 *  that calls a method during first render never races the handshake. */
function call(
	runtime: BridgeRuntime,
	method: string,
	args: unknown[],
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const id = runtime.nextId++;
		runtime.pending.set(id, { resolve, reject });
		const envelope: RpcEnvelope = { kind: RPC_REQUEST_KIND, id, method, args };
		if (runtime.port) {
			runtime.port.postMessage(envelope);
		} else {
			runtime.outbox.push(envelope);
		}
	});
}

function onPortMessage(runtime: BridgeRuntime, event: MessageEvent): void {
	const msg = event.data as
		| { kind?: string; id?: number; result?: unknown; error?: unknown }
		| null
		| undefined;
	if (!msg || msg.kind !== RPC_RESULT_KIND || typeof msg.id !== "number") {
		return;
	}
	const entry = runtime.pending.get(msg.id);
	if (!entry) {
		return;
	}
	runtime.pending.delete(msg.id);
	if (msg.error !== undefined && msg.error !== null) {
		entry.reject(normalizeError(msg.error));
	} else {
		entry.resolve(msg.result);
	}
}

function applyGlobals(
	runtime: BridgeRuntime,
	partial: Partial<RyuWidgetProps>,
): void {
	// Merge each present key onto the LIVE globals object (identity stable so
	// `window.openai === window.ryu` keeps holding), then notify subscribers.
	Object.assign(runtime.globals, partial);
	dispatchSetGlobals(partial);
}

function readNonce(): string | undefined {
	const injected = (window as BridgeWindow).__ryuWidgetNonce;
	if (typeof injected === "string" && injected.length > 0) {
		return injected;
	}
	const meta = document.querySelector('meta[name="ryu:nonce"]');
	const content = meta?.getAttribute("content");
	return content && content.length > 0 ? content : undefined;
}

function onWindowMessage(
	runtime: BridgeRuntime,
	nonce: string,
	event: MessageEvent,
): void {
	const msg = event.data as
		| { kind?: string; nonce?: string }
		| null
		| undefined;
	if (!msg) {
		return;
	}
	// Accept the port ONLY from the host message carrying our nonce, and only once.
	if (msg.kind === HOST_PORT_KIND && msg.nonce === nonce && !runtime.port) {
		const port = event.ports?.[0];
		if (!port) {
			return;
		}
		runtime.port = port;
		port.onmessage = (portEvent) => onPortMessage(runtime, portEvent);
		flushOutbox(runtime);
		// Reconcile with the host's authoritative snapshot after connect. Initial
		// props were already injected synchronously (D2); this catches any drift.
		call(runtime, METHOD_GET_GLOBALS, [])
			.then((snapshot) => {
				if (snapshot && typeof snapshot === "object") {
					applyGlobals(runtime, snapshot as Partial<RyuWidgetProps>);
				}
			})
			.catch(() => {
				// getGlobals is best-effort; the synchronous injection is the source
				// of truth on first paint.
			});
		return;
	}
	// The host may also push globals over the window (belt-and-suspenders; the
	// primary push path is the port once connected).
	if (msg.kind === SET_GLOBALS_KIND) {
		const globals = (msg as { globals?: Partial<RyuWidgetProps> }).globals;
		if (globals && typeof globals === "object") {
			applyGlobals(runtime, globals);
		}
	}
}

function buildMethods(
	runtime: BridgeRuntime,
): Pick<
	RyuWidgetGlobals,
	| "setWidgetState"
	| "callTool"
	| "sendFollowUpMessage"
	| "requestDisplayMode"
	| "requestModal"
	| "requestClose"
	| "notifyIntrinsicHeight"
	| "openExternal"
> {
	return {
		setWidgetState: async (state: unknown) => {
			// Optimistically reflect the write locally so `useRyuGlobal("widgetState")`
			// updates immediately; the host persists authoritatively (D4).
			applyGlobals(runtime, { widgetState: state });
			await call(runtime, METHOD_SET_STATE, [state]);
		},
		callTool: (name: string, args: unknown) =>
			call(runtime, METHOD_TOOL_CALL, [name, args]),
		sendFollowUpMessage: async (args: { prompt: string }) => {
			await call(runtime, METHOD_SEND_MESSAGE, [args]);
		},
		requestDisplayMode: (args: { mode: WidgetDisplayMode }) =>
			call(runtime, METHOD_REQUEST_DISPLAY_MODE, [args]) as Promise<{
				mode: string;
			}>,
		requestModal: async () => {
			await call(runtime, METHOD_REQUEST_DISPLAY_MODE, [
				{ mode: "fullscreen" },
			]);
		},
		requestClose: async () => {
			await call(runtime, METHOD_REQUEST_CLOSE, []);
		},
		notifyIntrinsicHeight: (px: number) => {
			// Fire-and-forget; the reply is consumed but not surfaced.
			void call(runtime, METHOD_NOTIFY_HEIGHT, [px]);
		},
		openExternal: async (args: { href: string }) => {
			await call(runtime, METHOD_OPEN_EXTERNAL, [args]);
		},
	};
}

/**
 * Install the widget bridge and return the live `window.ryu` object. Idempotent:
 * repeated calls (e.g. from both `host.tsx` and the openai shim) return the same
 * runtime and never re-run the handshake.
 *
 * Reads any host-injected synchronous props off `window.ryu` and preserves them,
 * layers the RPC-backed methods on top, wires the port handshake, and starts
 * applying `ryu-widget-set-globals` pushes.
 */
export function installRyuBridge(): RyuWidgetGlobals {
	const win = window as BridgeWindow;

	// The host-injected synchronous bootstrap (`widget-bootstrap.ts`, D2) is
	// AUTHORITATIVE: it already installed `window.ryu`, holds the transferred
	// MessagePort in a closure, and dispatches `ryu:set_globals` on host pushes. If it
	// ran, adopt it as-is — building a second, port-less runtime over the top would
	// strand every callTool/sendFollowUpMessage/setWidgetState in a dead outbox.
	if (win[HOST_BRIDGE_KEY] && isLiveBridge(win.ryu)) {
		return win.ryu;
	}

	const existingRuntime = win[RUNTIME_KEY];
	if (existingRuntime) {
		return existingRuntime.globals;
	}

	// Seed props from whatever the host injected synchronously (D2), backfilling
	// any missing key with a default. `window.ryu` may be undefined, a bare props
	// object, or a partially-populated one.
	const injected = (window.ryu ?? {}) as Partial<RyuWidgetGlobals>;
	const globals = {
		...DEFAULT_PROPS,
		...injected,
	} as RyuWidgetGlobals;

	const runtime: BridgeRuntime = {
		port: null,
		nextId: 1,
		pending: new Map(),
		outbox: [],
		globals,
	};
	win[RUNTIME_KEY] = runtime;

	Object.assign(globals, buildMethods(runtime));

	// `window.ryu` IS the runtime globals object; the openai shim aliases
	// `window.openai` to the same reference.
	window.ryu = globals;

	const nonce = readNonce();
	if (nonce) {
		window.addEventListener("message", (event) =>
			onWindowMessage(runtime, nonce, event),
		);
		// Announce readiness so the host verifies source + nonce and transfers a port.
		window.parent.postMessage({ kind: READY_KIND, nonce }, "*");
	}

	return globals;
}
