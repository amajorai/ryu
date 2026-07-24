// The desktop extension host (#446): renders a plugin's UI in a SANDBOXED,
// null-origin <iframe> and establishes a capability-gated postMessage RPC bridge
// between the host (this trusted webview) and the plugin (the frame).
//
// Security model (see `docs/desktop-extension-host-spec.md` §3, and the advisor
// note baked into the comments below):
//   - `sandbox="allow-scripts"` WITHOUT `allow-same-origin`: the frame runs at a
//     NULL origin. It cannot read the parent DOM, cannot touch app storage, and
//     does NOT receive `window.__TAURI__` (Tauri injects IPC into the app's own
//     webview, not a null-origin sandboxed frame). The plugin reaches Core ONLY by
//     RPC over the bridge, which the host grant-gates.
//   - Because the frame is null-origin, `event.origin` is the literal string
//     "null" and is USELESS as an auth boundary (any null-origin context matches).
//     The real identity check is `event.source === iframe.contentWindow` PLUS a
//     host-generated nonce echoed in the handshake. Do NOT "harden" this with an
//     origin allowlist; it would be security theatre here.
//   - After the verified handshake the host creates a MessageChannel, transfers
//     `port2` into the frame, and runs all RPC over `port1`. Point-to-point ports
//     sidestep the `targetOrigin: "*"` ambiguity a null-origin frame would force.

import type { MutableRefObject } from "react";
import { useEffect, useRef } from "react";
import {
	asAgentRunArg,
	asFinetuneIdArg,
	asRpcRequest,
	assertGranted,
	type Capability,
	CodedRpcError,
	dispatchRpc,
	type HostPush,
	type HostServices,
	type RpcChunk,
	type RpcResponse,
	STREAMING_METHODS,
	toRpcError,
} from "./rpc.ts";

/** The iframe `sandbox` token list — the whole isolation boundary in one
 *  constant. `allow-scripts` ONLY: NO `allow-same-origin` (which would grant the
 *  frame the app's origin → parent DOM, cookies, storage, and Tauri IPC), and NO
 *  `allow-popups` / `allow-top-navigation` / `allow-forms`. Exported so the
 *  DOM-free `sandbox_never_same_origin` test can assert it without rendering the
 *  component. Do NOT add `allow-same-origin`; it converts the sandbox into full
 *  parent access (invariant #2). */
export const IFRAME_SANDBOX = "allow-scripts";

/** Inputs to the handshake decision, pulled out of the DOM event so the decision
 *  is a pure function. */
export interface HandshakeInputs {
	/** Whether a port has already been transferred (a channel already exists). A
	 *  second "ready" after connect must NEVER mint a second channel. */
	alreadyConnected: boolean;
	/** The nonce the host baked into `srcdoc` and expects echoed back. */
	expectedNonce: string;
	/** Whether `event.source === iframe.contentWindow` (the frame we created).
	 *  `event.origin` is the literal "null" for a null-origin frame and is NOT a
	 *  usable auth boundary, so source-identity + nonce carry the check. */
	fromThisFrame: boolean;
}

/**
 * Decide whether to transfer a fresh RPC port in response to a window message.
 *
 * Returns `true` ONLY when the message is a `ryu-plugin-ready` echoing the
 * expected nonce, from the frame we created, and no channel exists yet. Pure so
 * the adversarial tests (`forged_nonce_rejected`, `wrong_source_rejected`,
 * `stolen_port_second_handshake_rejected`) can assert every rejection path
 * without a DOM.
 */
export function shouldTransferPort(
	data: unknown,
	{ expectedNonce, fromThisFrame, alreadyConnected }: HandshakeInputs
): boolean {
	if (alreadyConnected) {
		return false;
	}
	const msg = data as { kind?: string; nonce?: string } | null;
	const isReady =
		msg?.kind === "ryu-plugin-ready" && msg.nonce === expectedNonce;
	return Boolean(isReady && fromThisFrame);
}

/**
 * Extract the `hostApiVersion` a frame announces in its `ryu-plugin-ready`
 * handshake, or `null` when absent (a LEGACY frame built before the envelope was
 * versioned). Pure so it is unit-testable without a DOM.
 *
 * The host TOLERATES a missing version this major — the contract is additive
 * within a major, so a `1.x` frame loads on a `1.y` (y ≥ x) host unchanged.
 * Absence is annotated (the caller stamps it on the iframe), never
 * rejected: {@link shouldTransferPort} — the accept/reject gate — deliberately
 * does NOT read this field.
 */
export function handshakeHostApiVersion(data: unknown): string | null {
	const msg = data as { hostApiVersion?: unknown } | null;
	const v = msg?.hostApiVersion;
	return typeof v === "string" && v.length > 0 ? v : null;
}

export interface ExtensionHostProps {
	/** Capabilities the host grants this plugin instance. For the MVP this is
	 *  host-provided config; reading it from `manifest.json` grants is #443. */
	granted: ReadonlySet<Capability>;
	/** The host-generated nonce baked into `srcdoc`. The frame echoes it in its
	 *  "ready" handshake; the host verifies it before transferring the RPC port. */
	nonce: string;
	/** Optional: notified when the bridge connects, for UI affordances. */
	onConnected?: () => void;
	/** Optional (widget host, ADDITIVE): a ref the host fills with a push function
	 *  once the port is live, so the caller can send `ryu-widget-set-globals` to the
	 *  frame (spec §1.2 `HostPush`). Cleared to `null` on unmount. The plugin caller
	 *  (`PluginHostPanel`) omits it and is unaffected. */
	pushRef?: MutableRefObject<((msg: HostPush) => void) | null>;
	/** The privileged services the host runs on the plugin's behalf (the plugin
	 *  never holds the Core token). */
	services: HostServices;
	/** The plugin's sandboxed document. Must already have `nonce` interpolated by
	 *  its builder (see `example-plugin.ts`). */
	srcdoc: string;
	title: string;
}

export function ExtensionHost({
	srcdoc,
	nonce,
	granted,
	services,
	onConnected,
	pushRef,
	title,
}: ExtensionHostProps) {
	const iframeRef = useRef<HTMLIFrameElement>(null);

	// Hold the callback-ish props in refs so the bridge effect depends ONLY on the
	// memoized `granted`/`nonce` and runs exactly once per mount. Without this, an
	// inline `services`/`onConnected` (new identity each render, the common caller
	// mistake) would re-run the effect, and its cleanup would close the live port
	// right after a successful handshake; the iframe (srcDoc unchanged) would NOT
	// reload to re-announce, silently killing the bridge. Refs read the latest
	// value without becoming effect dependencies.
	const servicesRef = useRef(services);
	servicesRef.current = services;
	const onConnectedRef = useRef(onConnected);
	onConnectedRef.current = onConnected;
	// Mirror the caller's pushRef (a stable ref object, but hold it via our own ref
	// so the bridge effect stays keyed on [granted, nonce] only, like the others).
	const pushRefRef = useRef(pushRef);
	pushRefRef.current = pushRef;

	useEffect(() => {
		const iframe = iframeRef.current;
		if (!iframe) {
			return;
		}
		let port: MessagePort | null = null;
		let disposed = false;
		// Active streaming calls (e.g. agent.run.stream), keyed by request id, so an
		// `agent.cancel` can abort the matching in-flight stream and unmount can abort
		// all of them.
		const activeStreams = new Map<number, AbortController>();

		// Post the terminal reply that ends a request (unary or streaming).
		const postResult = (id: number, result?: unknown, error?: unknown) => {
			const reply: RpcResponse = error
				? { kind: "ryu-plugin-rpc-result", id, error: toRpcError(error) }
				: { kind: "ryu-plugin-rpc-result", id, result };
			port?.postMessage(reply);
		};

		// RPC handler over the channel port: validate envelope, gate-dispatch, reply.
		const onPortMessage = (event: MessageEvent) => {
			const req = asRpcRequest(event.data);
			if (!(req && port)) {
				return;
			}

			// Cancel an in-flight stream. Aborting a stream the frame ITSELF started
			// (present in `activeStreams`) needs no extra grant — the grant was already
			// enforced when the stream was created, and the frame can only reach its own
			// AbortControllers here. This lets any streaming family (agent.run.stream OR
			// finetune.stream) be cancelled by the app that owns it, without forcing the
			// finetune app to also hold `hook:run-agent`. A cancel targeting no active
			// stream is a harmless no-op.
			if (req.method === "agent.cancel") {
				const targetId = req.args[0];
				if (typeof targetId === "number") {
					activeStreams.get(targetId)?.abort();
				}
				postResult(req.id, null);
				return;
			}

			// Streaming methods: push many `ryu-plugin-rpc-chunk` frames, then one
			// terminal result. Same capability gate as the unary path.
			if (STREAMING_METHODS.has(req.method)) {
				try {
					assertGranted(req.method, granted);
				} catch (err) {
					postResult(req.id, undefined, err);
					return;
				}
				// Resolve the streaming service + validated input per method. Every
				// streaming service shares the (input, emit, signal) shape; we bind the
				// validated input into a uniform `start(emit, signal)` closure so the
				// machinery below (duplicate-id guard, AbortController, teardown) is
				// method-agnostic. The shell subscribe/register verbs (grant
				// `shell:integrate`) take a LOOSE object arg (the service validates its own
				// shape) and, like every stream, are cancel-on-unmount via `activeStreams`.
				let start:
					| ((
							emit: (delta: string) => void,
							signal: AbortSignal
					  ) => Promise<void>)
					| undefined;
				let streamError: CodedRpcError | undefined;
				const shellArg: Record<string, unknown> =
					req.args[0] && typeof req.args[0] === "object"
						? (req.args[0] as Record<string, unknown>)
						: {};
				const bindShellStream = (
					svc:
						| ((
								input: Record<string, unknown>,
								emit: (delta: string) => void,
								signal: AbortSignal
						  ) => Promise<void>)
						| undefined
				) => {
					if (svc) {
						start = (emit, signal) => svc(shellArg, emit, signal);
					} else {
						streamError = new CodedRpcError(
							"server_error",
							`${req.method} is not available`
						);
					}
				};
				if (req.method === "shell.themeSubscribe") {
					bindShellStream(servicesRef.current.shellThemeSubscribe);
				} else if (req.method === "shell.registerCommand") {
					bindShellStream(servicesRef.current.shellRegisterCommand);
				} else if (req.method === "shell.eventsSubscribe") {
					bindShellStream(servicesRef.current.shellEventsSubscribe);
				} else if (req.method === "finetune.stream") {
					const arg = asFinetuneIdArg(req.args[0]);
					const svc = servicesRef.current.finetuneStream;
					if (!arg) {
						streamError = new CodedRpcError(
							"invalid_args",
							"finetune.stream requires a { id: string }"
						);
					} else if (svc) {
						start = (emit, signal) => svc(arg, emit, signal);
					} else {
						streamError = new CodedRpcError(
							"server_error",
							"finetune.stream is not available"
						);
					}
				} else {
					const arg = asAgentRunArg(req.args[0]);
					const svc = servicesRef.current.runAgentStream;
					if (!arg) {
						streamError = new CodedRpcError(
							"invalid_args",
							"agent.run.stream requires a { task: string }"
						);
					} else if (svc) {
						start = (emit, signal) => svc(arg, emit, signal);
					} else {
						streamError = new CodedRpcError(
							"server_error",
							"agent.run.stream is not available"
						);
					}
				}
				if (!start) {
					postResult(
						req.id,
						undefined,
						streamError ??
							new CodedRpcError("server_error", "stream is not available")
					);
					return;
				}
				// `req.id` is chosen by the (untrusted) frame. Refuse a duplicate of an
				// already-active stream so a colliding id cannot orphan the first
				// stream's AbortController from the cancel map (nor have one stream's
				// terminal `delete` drop the other's entry).
				if (activeStreams.has(req.id)) {
					postResult(
						req.id,
						undefined,
						new CodedRpcError("invalid_args", "stream id already active")
					);
					return;
				}
				const controller = new AbortController();
				activeStreams.set(req.id, controller);
				const emit = (delta: string) => {
					const chunk: RpcChunk = {
						kind: "ryu-plugin-rpc-chunk",
						id: req.id,
						delta,
					};
					port?.postMessage(chunk);
				};
				start(emit, controller.signal)
					.then(() => postResult(req.id, null))
					.catch((err: unknown) => postResult(req.id, undefined, err))
					.finally(() => activeStreams.delete(req.id));
				return;
			}

			dispatchRpc(req.method, req.args, granted, servicesRef.current)
				.then((result) => {
					const reply: RpcResponse = {
						kind: "ryu-plugin-rpc-result",
						id: req.id,
						result,
					};
					port?.postMessage(reply);
				})
				.catch((err: unknown) => {
					const reply: RpcResponse = {
						kind: "ryu-plugin-rpc-result",
						id: req.id,
						// A widget CodedRpcError serializes to `{ code, message }`; a legacy
						// CapabilityError stays a plain string (D6, backward-compatible).
						error: toRpcError(err),
					};
					port?.postMessage(reply);
				});
		};

		// Handshake: accept the "ready" ONLY from THIS frame (event.source identity)
		// AND only when it echoes our nonce. Then transfer a fresh channel port.
		const onWindowMessage = (event: MessageEvent) => {
			if (disposed) {
				return;
			}
			// The load-bearing decision, delegated to the pure predicate: correct
			// nonce, from the window we created (`event.origin` is "null" here and
			// intentionally NOT checked), and no channel already transferred.
			if (
				!shouldTransferPort(event.data, {
					expectedNonce: nonce,
					fromThisFrame: event.source === iframe.contentWindow,
					alreadyConnected: port !== null,
				})
			) {
				return;
			}
			// Annotate the host-API version the frame was built against (or "legacy"
			// when the envelope carries none). Inspectable in devtools; NOT a gate —
			// the handshake is already accepted (no rejection this major).
			iframe.dataset.pluginHostApiVersion =
				handshakeHostApiVersion(event.data) ?? "legacy";
			const channel = new MessageChannel();
			port = channel.port1;
			port.onmessage = onPortMessage;
			// Hand port2 to the frame, tagged with the nonce so the frame accepts
			// only the port meant for it. targetOrigin "*" is unavoidable for a
			// null-origin frame; the nonce + the just-verified source carry the auth.
			iframe.contentWindow?.postMessage(
				{ kind: "ryu-plugin-host-port", nonce },
				"*",
				[channel.port2]
			);
			onConnectedRef.current?.();
			// ADDITIVE (widget host): expose a push channel so the caller can send
			// `ryu-widget-set-globals` to the frame over the same live port.
			const pushTarget = pushRefRef.current;
			if (pushTarget) {
				pushTarget.current = (msg: HostPush) => port?.postMessage(msg);
			}
		};

		window.addEventListener("message", onWindowMessage);
		return () => {
			disposed = true;
			window.removeEventListener("message", onWindowMessage);
			const pushTarget = pushRefRef.current;
			if (pushTarget) {
				pushTarget.current = null;
			}
			// Abort any in-flight streams so their fetches/tasks stop on unmount.
			for (const controller of activeStreams.values()) {
				controller.abort();
			}
			activeStreams.clear();
			if (port) {
				port.onmessage = null;
				port.close();
				port = null;
			}
		};
	}, [granted, nonce]);

	return (
		<iframe
			className="h-full w-full border-0 bg-background"
			ref={iframeRef}
			// allow-scripts WITHOUT allow-same-origin → null origin, no Tauri IPC.
			sandbox={IFRAME_SANDBOX}
			srcDoc={srcdoc}
			title={title}
		/>
	);
}
