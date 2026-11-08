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
// `apps/extension/entrypoints/sandbox/main.ts`. Such a host passes `sandboxPage`:
// the frame loads that page, which receives this same document once and writes
// it over itself, so everything below (nonce, source identity, grant gate) holds.
//
// Before tightening a host surface's CSP, run `apps/desktop/e2e/companion-host.spec.ts`
// — it mounts real app bundles under the shell policy read out of the Tauri config.
// The full rationale for the shipped `script-src` / `script-src-elem` /
// `script-src-attr` split lives in `docs/desktop-extension-host-spec.md` §3.1.

import { useEffect, useLayoutEffect, useRef } from "react";
import { z } from "zod";
import {
	asRpcRequest,
	assertGranted,
	CodedRpcError,
	dispatchRpc,
	type RpcChunk,
	type RpcResponse,
	STREAMING_METHODS,
	toRpcError,
} from "./rpc.ts";

export {
	APP_DOWNLOAD_GRANT,
	type ExtensionFrameMessage,
	frameMessageSchema,
	type HandshakeInputs,
	handshakeHostApiVersion,
	IFRAME_SANDBOX,
	SANDBOX_DOCUMENT_KIND,
	SANDBOX_READY_KIND,
	type SandboxDocumentMessage,
	sandboxDocumentMessageSchema,
	sandboxForCompanion,
	sandboxForDownloads,
	shouldEnableCompanionFormEvents,
	shouldSendSandboxDocument,
	shouldTransferPort,
} from "./extension-host-handshake.ts";

import {
	frameMessageSchema,
	handshakeHostApiVersion,
	sandboxForCompanion,
	shouldTransferPort,
} from "./extension-host-handshake.ts";

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

export type { ExtensionHostProps } from "./extension-host-props.ts";

import { createCallBudget } from "./call-budget.ts";
import type { ExtensionHostProps } from "./extension-host-props.ts";
import { createMcpAppBridge } from "./mcp-app-bridge.ts";
import {
	armNavigationTeardown,
	sandboxFrameState,
	sendSandboxDocument,
} from "./sandbox-frame-guard.ts";
import { createLivenessGate } from "./sandbox-liveness-gate.ts";

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
	sandboxPage,
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
	// Counts document changes for the sandbox-page transport's iframe key.
	const documentGeneration = useRef({ generation: 0, srcdoc });
	if (documentGeneration.current.srcdoc !== srcdoc) {
		documentGeneration.current = {
			generation: documentGeneration.current.generation + 1,
			srcdoc,
		};
	}

	useHandshakeEffect(() => {
		const iframe = iframeRef.current;
		const expectedSandbox = sandboxForCompanion({
			allowDownloads,
			allowForms,
			srcdoc,
		});
		const documentLoaded =
			sandboxPage === undefined
				? iframe?.srcdoc === srcdoc
				: iframe?.getAttribute("src") === sandboxPage;
		if (
			!(iframe && documentLoaded) ||
			iframe.getAttribute("sandbox") !== expectedSandbox
		) {
			return;
		}
		// Sandbox-page transport: per-ELEMENT state, so the document goes over once
		// per iframe (not once per effect run) and a self-navigated frame, whose
		// new document escapes `connect-src 'none'`, is never bridged again.
		const frameState =
			sandboxPage === undefined ? null : sandboxFrameState(iframe);
		if (frameState?.navigated) {
			return;
		}
		let port: MessagePort | null = null;
		let disposed = false;
		// Active streaming calls (e.g. agent.run.stream), keyed by request id, so an
		// `agent.cancel` can abort the matching in-flight stream and unmount can abort
		// all of them.
		const activeStreams = new Map<number, AbortController>();
		// One per-frame in-flight budget for unary and streaming calls, so one app
		// cannot turn a valid grant into unbounded promise/service work.
		const { tryAcquireCall, releaseCall } = createCallBudget();
		// Sandbox-page window traffic is delivered only once the realm holding the
		// port acknowledges a probe (a self-navigated document cannot).
		const liveness = frameState ? createLivenessGate() : null;
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
			if (liveness?.handlePortMessage(event.data)) {
				return;
			}
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
			// At most once per sandbox-page element, never on a handshake re-run.
			if (sendSandboxDocument(frameState, event, iframe, { srcdoc, nonce })) {
				return;
			}
			if (event.source === iframe.contentWindow) {
				const data: unknown = event.data;
				const deliver = () => {
					if (disposed) {
						return;
					}
					const message = frameMessageSchema.safeParse(data);
					if (message.success) {
						onMessageRef.current?.(message.data);
					}
					void mcpApp.receive(data);
				};
				if (liveness) {
					liveness.admit(deliver);
				} else {
					deliver();
				}
			}
			// The load-bearing decision, delegated to the pure predicate: correct
			// nonce, from the window we created (`event.origin` is "null" here and
			// intentionally NOT checked), and no channel already transferred.
			if (
				!shouldTransferPort(event.data, {
					expectedNonce: nonce,
					fromThisFrame: event.source === iframe.contentWindow,
					alreadyConnected:
						port !== null || (frameState?.portTransferred ?? false),
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
			if (frameState) {
				frameState.portTransferred = true;
			}
			liveness?.attach(port);
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

		const teardown = () => {
			disposed = true;
			liveness?.dispose();
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
		window.addEventListener("message", onWindowMessage);
		const disarm = armNavigationTeardown(frameState, iframe, teardown);
		return () => {
			disarm();
			teardown();
		};
	}, [allowDownloads, allowForms, granted, nonce, sandboxPage, srcdoc]);

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
			// A sandbox page's `src` never changes, so its key also carries the
			// document generation: a new document (a retry's fresh nonce included)
			// reloads the page, as a changed `srcdoc` reloads a srcdoc frame.
			key={`${sandboxForCompanion({
				allowDownloads,
				allowForms,
				srcdoc,
			})}${sandboxPage === undefined ? "" : ` ${documentGeneration.current.generation}`}`}
			ref={iframeRef}
			// The approved export grant adds downloads without changing the null origin.
			sandbox={sandboxForCompanion({
				allowDownloads,
				allowForms,
				srcdoc,
			})}
			src={sandboxPage}
			srcDoc={sandboxPage === undefined ? srcdoc : undefined}
			title={title}
			width="100%"
		/>
	);
}
