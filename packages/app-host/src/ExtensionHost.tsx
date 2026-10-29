import { resolveRpcStream } from "./streaming-rpc.ts";
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
//
// ! THE FRAME'S CSP IS NOT THE ONLY CSP IT OBEYS. A document loaded from
// `about:srcdoc` gets NO fresh policy container — it INHERITS the embedder's CSP,
// and the inherited policy and the frame's own `<meta>` policy then apply as a
// conjunction. So the bootstrap that posts `ryu-plugin-ready` runs only if the
// EMBEDDING SHELL's `script-src` also permits inline script. It does not degrade:
// the frame goes silent, no handshake ever lands, and every app sits on
// "the sandboxed interface hasn't connected yet" forever.
//
// That is not hypothetical — setting `app.security.csp` to `script-src 'self'` in
// `apps/desktop/src-tauri/tauri.conf.json` killed every companion, widget and
// artifact frame in packaged builds (dev builds load from the vite devUrl, which
// serves no CSP, so it looked fine right up to the installer). `apps/extension`
// hit the same wall under MV3, where the page CSP cannot be loosened at all, and
// had to move to a real sandbox page with `iframe src` — see
// `apps/extension/entrypoints/sandbox/main.ts`.
//
// Before tightening a host surface's CSP, run `apps/desktop/e2e/companion-host.spec.ts`
// — it mounts real app bundles under the shell policy read out of the Tauri config.
// The full rationale for the shipped `script-src` / `script-src-elem` /
// `script-src-attr` split lives in `docs/desktop-extension-host-spec.md` §3.1.

import type { RefObject } from "react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { z } from "zod";
import {
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

// Window/port envelopes are decoded before lifecycle decisions and callbacks.
const readyMessageSchema = z.object({
	kind: z.literal("ryu-plugin-ready"),
	nonce: z.string(),
});
const readyBoundarySchema = z.unknown().transform((data) => {
	const parsed = readyMessageSchema.safeParse(data);
	return parsed.success ? parsed.data : null;
});
const handshakeVersionSchema = z.object({ hostApiVersion: z.string().min(1) });
const handshakeVersionBoundarySchema = z
	.unknown()
	.transform((data): string | null => {
		const parsed = handshakeVersionSchema.safeParse(data);
		return parsed.success ? parsed.data.hostApiVersion : null;
	});
export const frameMessageSchema = z.record(z.string(), z.unknown());
export type ExtensionFrameMessage = z.infer<typeof frameMessageSchema>;

/** The base iframe sandbox. Never add `allow-same-origin`, which would grant the
 *  frame the app's origin → parent DOM, cookies, storage, and Tauri IPC. Popups
 *  and top-navigation are always disabled. Forms are opt-in only for trusted
 *  compiled HTML Companions with `connect-src 'none'` and `form-action 'none'`
 *  CSP; downloads use their separate Gateway-approved grant. */
export const IFRAME_SANDBOX = "allow-scripts";

/** Manifest grant that lets a sandboxed Companion export a user-requested file. */
export const APP_DOWNLOAD_GRANT = "files:download";

/** Forms are enabled only for compiled-in first-party full-HTML Companions. */
export function shouldEnableCompanionFormEvents(
	firstParty: boolean,
	isHtmlBundle: boolean
): boolean {
	return firstParty && isHtmlBundle;
}

/** Add only the browser download capability to the null-origin sandbox. */
export function sandboxForDownloads(allowDownloads: boolean): string {
	return allowDownloads ? `${IFRAME_SANDBOX} allow-downloads` : IFRAME_SANDBOX;
}

/**
 * Compose a first-party HTML Companion sandbox without enabling document
 * navigation. Local React form handlers need the `allow-forms` sandbox token,
 * while the companion CSP's `connect-src 'none'; form-action 'none'` keeps the
 * frame from reaching the network or submitting a form body. Callers opt in only
 * for trusted compiled HTML bundles; Path A and third-party frames retain the default.
 */
export function sandboxForCompanion(options: {
	allowDownloads?: boolean;
	allowForms?: boolean;
	srcdoc: string;
}): string {
	const tokens = [IFRAME_SANDBOX];
	const csp = options.srcdoc.match(
		/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i
	)?.[1];
	const egressLocked = csp
		? /(?:^|;)\s*connect-src\s+'none'(?=\s*(?:;|$))/i.test(csp)
		: false;
	const formActionsLocked = csp
		? /(?:^|;)\s*form-action\s+'none'(?=\s*(?:;|$))/i.test(csp)
		: false;
	if (options.allowForms && egressLocked && formActionsLocked) {
		tokens.push("allow-forms");
	}
	if (options.allowDownloads) {
		tokens.push("allow-downloads");
	}
	return tokens.join(" ");
}

/**
 * Attach the handshake listener during the COMMIT, not from a passive effect.
 *
 * React flushes `useEffect` in a scheduler task, which the iframe's own load task
 * can beat — and a `ryu-plugin-ready` posted before the listener exists is dropped
 * with nothing to re-deliver it. The frame now re-announces until the port lands
 * (`handshakeAnnounceScript`), so this is no longer load-bearing; it just closes
 * the window instead of paying a retry tick for it. `useLayoutEffect` warns under
 * SSR, so fall back to `useEffect` where there is no DOM.
 */
const useHandshakeEffect =
	globalThis.document === undefined ? useEffect : useLayoutEffect;

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
	data: z.input<typeof readyBoundarySchema>,
	{ expectedNonce, fromThisFrame, alreadyConnected }: HandshakeInputs
): boolean {
	if (alreadyConnected) {
		return false;
	}
	const msg = readyBoundarySchema.parse(data);
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
export const handshakeHostApiVersion = handshakeVersionBoundarySchema.parse;

export interface ExtensionHostProps {
	/** True only when the Gateway-approved `files:download` grant is present. */
	allowDownloads?: boolean;
	/**
	 * Opt into local HTML form handlers for a trusted compiled Companion. The
	 * host additionally requires both `connect-src 'none'` and `form-action 'none'`
	 * in `srcdoc`, so forms cannot reach the network, navigate, or transmit a body.
	 * Default false keeps third-party and widget frames at the base sandbox.
	 */
	allowForms?: boolean;
	/** Capabilities the host grants this plugin instance. For the MVP this is
	 *  host-provided config; reading it from `manifest.json` grants is #443. */
	granted: ReadonlySet<Capability>;
	/** The host-generated nonce baked into `srcdoc`. The frame echoes it in its
	 *  "ready" handshake; the host verifies it before transferring the RPC port. */
	nonce: string;
	/** Optional: notified when the bridge connects, for UI affordances. */
	onConnected?: () => void;
	/**
	 * Optional host-owned messages emitted by the mounted frame. The callback is
	 * invoked only for messages whose source is this iframe; RPC handshakes still
	 * remain handled by the host below.
	 */
	onMessage?: (data: ExtensionFrameMessage) => void;
	/** Optional (widget host, ADDITIVE): a ref the host fills with a push function
	 *  once the port is live, so the caller can send `ryu-widget-set-globals` to the
	 *  frame (spec §1.2 `HostPush`). Cleared to `null` on unmount. The plugin caller
	 *  (`PluginHostPanel`) omits it and is unaffected. */
	pushRef?: RefObject<((msg: HostPush) => void) | null>;
	/** The privileged services the host runs on the plugin's behalf (the plugin
	 *  never holds the Core token). */
	services: HostServices;
	/** The plugin's sandboxed document. Must already have `nonce` interpolated by
	 *  its builder (see `example-plugin.ts`). */
	srcdoc: string;
	/** Live host privacy state; unknown hosts keep connected-app summaries hidden. */
	streamingPrivacyActive?: boolean;
	/** Resolved host theme tokens to push into a mounted companion without
	 *  requiring the app to request the shell-integration capability. */
	themeTokens?: Readonly<Record<string, string>>;
	title: string;
}

import { createMcpAppBridge } from "./mcp-app-bridge.ts";

export function ExtensionHost({
	srcdoc,
	nonce,
	granted,
	allowDownloads = false,
	allowForms = false,
	services,
	onConnected,
	onMessage,
	pushRef,
	themeTokens,
	streamingPrivacyActive = true,
	title,
}: ExtensionHostProps) {
	const iframeRef = useRef<HTMLIFrameElement>(null);

	// Hold the callback-ish props in refs so the bridge effect depends ONLY on the
	// memoized grants, nonce, and source document. Without this, an
	// inline `services`/`onConnected` (new identity each render, the common caller
	// mistake) would re-run the effect, and its cleanup would close the live port
	// right after a successful handshake; the iframe (srcDoc unchanged) would NOT
	// reload to re-announce, silently killing the bridge. Refs read the latest
	// value without becoming effect dependencies.
	const servicesRef = useRef(services);
	servicesRef.current = services;
	const onConnectedRef = useRef(onConnected);
	onConnectedRef.current = onConnected;
	const onMessageRef = useRef(onMessage);
	onMessageRef.current = onMessage;
	// Mirror the caller's pushRef (a stable ref object, but hold it via our own ref
	// so the bridge effect stays keyed on [granted, nonce] only, like the others).
	const pushRefRef = useRef(pushRef);
	pushRefRef.current = pushRef;
	const privacyRef = useRef(streamingPrivacyActive);
	privacyRef.current = streamingPrivacyActive;

	useHandshakeEffect(() => {
		const iframe = iframeRef.current;
		const expectedSandbox = sandboxForCompanion({
			allowDownloads,
			allowForms,
			srcdoc,
		});
		if (
			!iframe ||
			iframe.srcdoc !== srcdoc ||
			iframe.getAttribute("sandbox") !== expectedSandbox
		) {
			return;
		}
		let port: MessagePort | null = null;
		let disposed = false;
		// Active streaming calls (e.g. agent.run.stream), keyed by request id, so an
		// `agent.cancel` can abort the matching in-flight stream and unmount can abort
		// all of them.
		const activeStreams = new Map<number, AbortController>();
		// Every valid unary and streaming request consumes the same per-frame
		// in-flight budget. This is intentionally owned by the host instance, so
		// one app cannot turn a valid grant into unbounded promise/service work.
		const MAX_IN_FLIGHT_CALLS = 32;
		let inFlightCalls = 0;
		const tryAcquireCall = (): boolean => {
			if (inFlightCalls >= MAX_IN_FLIGHT_CALLS) {
				return false;
			}
			inFlightCalls += 1;
			return true;
		};
		const releaseCall = (): void => {
			inFlightCalls = Math.max(0, inFlightCalls - 1);
		};
		const readLifetime = new AbortController();
		const mcpApp = createMcpAppBridge({
			granted,
			services: () => servicesRef.current,
			send: (message) => iframe.contentWindow?.postMessage(message, "*"),
		});
		const pushTarget = pushRefRef.current;
		if (pushTarget) {
			pushTarget.current = (message) => {
				port?.postMessage(message);
				mcpApp.push(message.globals);
			};
		}

		// Post the terminal reply that ends a request (unary or streaming).
		const postResult = (
			id: number,
			result?: RpcResponse["result"],
			cause?: unknown
		) => {
			const reply: RpcResponse = cause
				? { kind: "ryu-plugin-rpc-result", id, error: toRpcError(cause) }
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
				const parsed = z.number().safeParse(targetId);
				if (parsed.success) {
					activeStreams.get(parsed.data)?.abort();
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
				let start;
				try {
					start = resolveRpcStream(req.method, req.args, servicesRef.current);
				} catch (err) {
					postResult(req.id, undefined, err);
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
				if (!tryAcquireCall()) {
					postResult(
						req.id,
						undefined,
						new CodedRpcError("server_error", "too many in-flight app calls")
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
				void Promise.resolve()
					.then(() => start?.(emit, controller.signal))
					.then(() => postResult(req.id, null))
					.catch((cause: unknown) => postResult(req.id, undefined, cause))
					.finally(() => {
						activeStreams.delete(req.id);
						releaseCall();
					});
				return;
			}

			if (!tryAcquireCall()) {
				postResult(
					req.id,
					undefined,
					new CodedRpcError("server_error", "too many in-flight app calls")
				);
				return;
			}
			dispatchRpc(
				req.method,
				req.args,
				granted,
				servicesRef.current,
				readLifetime.signal
			)
				.then((result) => {
					const reply: RpcResponse = {
						kind: "ryu-plugin-rpc-result",
						id: req.id,
						result,
					};
					port?.postMessage(reply);
				})
				.catch((cause: unknown) => {
					const reply: RpcResponse = {
						kind: "ryu-plugin-rpc-result",
						id: req.id,
						// A widget CodedRpcError serializes to `{ code, message }`; a legacy
						// CapabilityError stays a plain string (D6, backward-compatible).
						error: toRpcError(cause),
					};
					port?.postMessage(reply);
				})
				.finally(releaseCall);
		};

		// Handshake: accept the "ready" ONLY from THIS frame (event.source identity)
		// AND only when it echoes our nonce. Then transfer a fresh channel port.
		const onWindowMessage = (event: MessageEvent) => {
			if (disposed) {
				return;
			}
			if (event.source === iframe.contentWindow) {
				if (onMessageRef.current) {
					const message = frameMessageSchema.safeParse(event.data);
					if (message.success) {
						onMessageRef.current(message.data);
					}
				}
				void mcpApp.receive(event.data);
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
			iframe.contentWindow?.postMessage(
				{
					kind: "ryu-plugin-privacy",
					nonce,
					streamingActive: privacyRef.current,
				},
				"*"
			);
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
		};

		window.addEventListener("message", onWindowMessage);
		return () => {
			disposed = true;
			readLifetime.abort();
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
	}, [allowDownloads, allowForms, granted, nonce, srcdoc]);

	useHandshakeEffect(() => {
		iframeRef.current?.contentWindow?.postMessage(
			{
				kind: "ryu-plugin-privacy",
				nonce,
				streamingActive: streamingPrivacyActive,
			},
			"*"
		);
	}, [nonce, streamingPrivacyActive]);

	useEffect(() => {
		const iframe = iframeRef.current;
		if (!(iframe && themeTokens)) {
			return;
		}
		iframe.contentWindow?.postMessage(
			{ kind: "ryu-plugin-theme", nonce, tokens: themeTokens },
			"*"
		);
	}, [nonce, themeTokens]);

	return (
		<iframe
			className="block h-full w-full border-0 bg-background"
			// Dimension attributes keep the frame filling its container in hosts
			// whose stylesheet does not generate the utility classes above.
			height="100%"
			key={sandboxForCompanion({
				allowDownloads,
				allowForms,
				srcdoc,
			})}
			ref={iframeRef}
			// The approved export grant adds downloads without changing the null origin.
			sandbox={sandboxForCompanion({
				allowDownloads,
				allowForms,
				srcdoc,
			})}
			srcDoc={srcdoc}
			title={title}
			width="100%"
		/>
	);
}
