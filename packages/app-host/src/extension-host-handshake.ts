// Pure handshake and sandbox-policy helpers for `ExtensionHost`. Split out so the
// adversarial and handshake tests can exercise every accept/reject path without a
// DOM; `ExtensionHost.tsx` re-exports these names, so its public import path is
// unchanged. The security rationale lives in that file's header.

import { z } from "zod";

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

// Sandbox-page transport (MV3 extension). A host surface whose own CSP forbids
// inline script (the extension dashboard: `script-src 'self'`) cannot mount an
// `about:srcdoc` frame, because srcdoc inherits that policy. Instead it loads a
// declared sandbox page by URL. That page has its own opaque origin and CSP; it
// announces `ryu-sandbox-ready` and the host answers ONCE with the same companion
// document desktop would have used as `srcdoc`. The page then writes that
// document over itself, so the companion's own bootstrap runs in the very window
// the host created and the ordinary nonce + source-identity handshake follows.
// Nothing privileged travels in this message: the document holds the bundle and
// the per-mount nonce, never a node token.

export const SANDBOX_READY_KIND = "ryu-sandbox-ready";
export const SANDBOX_DOCUMENT_KIND = "ryu-sandbox-document";

const sandboxReadySchema = z.object({ kind: z.literal(SANDBOX_READY_KIND) });

/** The one message the host sends a sandbox page: the companion document. */
export const sandboxDocumentMessageSchema = z.object({
	html: z.string().min(1),
	kind: z.literal(SANDBOX_DOCUMENT_KIND),
	nonce: z.string().min(1),
});
export type SandboxDocumentMessage = z.infer<
	typeof sandboxDocumentMessageSchema
>;

/**
 * Decide whether to answer a sandbox page's readiness with the companion
 * document: only a `ryu-sandbox-ready` from the frame this host created, and
 * only once per mount, so a replayed announcement cannot swap the document.
 */
export function shouldSendSandboxDocument(
	data: unknown,
	{
		alreadySent,
		fromThisFrame,
	}: { alreadySent: boolean; fromThisFrame: boolean }
): boolean {
	if (alreadySent || !fromThisFrame) {
		return false;
	}
	return sandboxReadySchema.safeParse(data).success;
}
