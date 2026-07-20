// DOM-free tests for the handshake decision predicate `shouldTransferPort` and
// the exported `IFRAME_SANDBOX` constant. `ExtensionHost` itself needs a real
// webview (iframe + window `message` events); its security-critical decisions are
// extracted into pure functions/constants precisely so they can be asserted here
// under `bun test` (no DOM), mirroring how `rpc.ts` is tested apart from the DOM.

import { describe, expect, it } from "bun:test";
import {
	handshakeHostApiVersion,
	IFRAME_SANDBOX,
	shouldTransferPort,
} from "./ExtensionHost.tsx";

const NONCE = "host-nonce-123";
const validReady = { kind: "ryu-plugin-ready", nonce: NONCE };

describe("shouldTransferPort handshake gate", () => {
	it("accepts a valid ready from this frame when not yet connected", () => {
		expect(
			shouldTransferPort(validReady, {
				expectedNonce: NONCE,
				fromThisFrame: true,
				alreadyConnected: false,
			})
		).toBe(true);
	});

	// forged_nonce_rejected
	it("rejects a ready echoing the WRONG nonce", () => {
		expect(
			shouldTransferPort(
				{ kind: "ryu-plugin-ready", nonce: "WRONG" },
				{ expectedNonce: NONCE, fromThisFrame: true, alreadyConnected: false }
			)
		).toBe(false);
	});

	// wrong_source_rejected
	it("rejects a valid ready that did NOT come from this frame", () => {
		expect(
			shouldTransferPort(validReady, {
				expectedNonce: NONCE,
				fromThisFrame: false,
				alreadyConnected: false,
			})
		).toBe(false);
	});

	// stolen_port_second_handshake_rejected
	it("rejects a second ready once a channel is already connected", () => {
		expect(
			shouldTransferPort(validReady, {
				expectedNonce: NONCE,
				fromThisFrame: true,
				alreadyConnected: true,
			})
		).toBe(false);
	});

	it("rejects a message of the wrong kind", () => {
		expect(
			shouldTransferPort(
				{ kind: "something-else", nonce: NONCE },
				{ expectedNonce: NONCE, fromThisFrame: true, alreadyConnected: false }
			)
		).toBe(false);
	});

	it("rejects a null / non-object payload", () => {
		expect(
			shouldTransferPort(null, {
				expectedNonce: NONCE,
				fromThisFrame: true,
				alreadyConnected: false,
			})
		).toBe(false);
	});
});

describe("handshakeHostApiVersion (versioned envelope, legacy-tolerant)", () => {
	it("returns the announced version when the ready carries one", () => {
		expect(
			handshakeHostApiVersion({ ...validReady, hostApiVersion: "1.0.0" })
		).toBe("1.0.0");
	});

	it("returns null for a LEGACY ready with no version (host tolerates it)", () => {
		expect(handshakeHostApiVersion(validReady)).toBeNull();
	});

	it("returns null when the version is an empty string", () => {
		expect(
			handshakeHostApiVersion({ ...validReady, hostApiVersion: "" })
		).toBeNull();
	});

	it("returns null for a non-string version or a null payload", () => {
		expect(
			handshakeHostApiVersion({ ...validReady, hostApiVersion: 1 })
		).toBeNull();
		expect(handshakeHostApiVersion(null)).toBeNull();
	});
});

// sandbox_never_same_origin
describe("iframe sandbox is locked down", () => {
	it("is exactly allow-scripts and never allow-same-origin", () => {
		expect(IFRAME_SANDBOX).toBe("allow-scripts");
		expect(IFRAME_SANDBOX).not.toContain("allow-same-origin");
	});

	it("never enables popups, top-navigation, or forms", () => {
		expect(IFRAME_SANDBOX).not.toContain("allow-popups");
		expect(IFRAME_SANDBOX).not.toContain("allow-top-navigation");
		expect(IFRAME_SANDBOX).not.toContain("allow-forms");
	});
});
