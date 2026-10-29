// DOM-free tests for the handshake decision predicate `shouldTransferPort` and
// the exported `IFRAME_SANDBOX` constant. `ExtensionHost` itself needs a real
// webview (iframe + window `message` events); its security-critical decisions are
// extracted into pure functions/constants precisely so they can be asserted here
// under `bun test` (no DOM), mirroring how `rpc.ts` is tested apart from the DOM.

import { describe, expect, it } from "bun:test";
import {
	APP_DOWNLOAD_GRANT,
	handshakeHostApiVersion,
	IFRAME_SANDBOX,
	sandboxForCompanion,
	sandboxForDownloads,
	shouldEnableCompanionFormEvents,
	shouldTransferPort,
} from "./ExtensionHost.tsx";
import { examplePluginSrcdoc } from "./example-plugin.ts";
import { handshakeAnnounceScript } from "./rpc.ts";
import {
	htmlCompanionSrcdoc,
	thirdPartyPluginSrcdoc,
} from "./third-party-plugin.ts";

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

// The frame side of the handshake. A frame that announces ONCE loses the race
// whenever its load task beats the host's (passive-effect-scheduled) listener, and
// nothing re-delivers a dropped `ryu-plugin-ready`: the panel then sits on
// "starting…" forever and a Path-A bundle never even evaluates, because it is only
// run once the port lands. Every builder must therefore re-announce until
// connected, and must stop as soon as it holds a port (the host also refuses every
// announce after the first — `alreadyConnected` above — so a duplicate can never
// mint a second channel).
describe("every sandboxed frame re-announces until the port arrives", () => {
	const builders: [string, string][] = [
		["example plugin", examplePluginSrcdoc("nonce-a")],
		[
			"third-party (Path A, ESM bundle)",
			thirdPartyPluginSrcdoc("nonce-b", "", "com.test.a"),
		],
		[
			"html companion (Path B)",
			htmlCompanionSrcdoc("nonce-c", "<p>hi</p>", "com.test.b"),
		],
	];

	for (const [name, doc] of builders) {
		it(`${name} announces, then repeats on a timer`, () => {
			expect(doc).toContain('{ kind: "ryu-plugin-ready", nonce: NONCE');
			expect(doc).toContain("setInterval");
			expect(doc).toContain("ryuAnnounceReady");
		});

		it(`${name} stops announcing once it holds a port`, () => {
			expect(doc).toContain(
				"if (port) { clearInterval(ryuReadyTimer); return; }"
			);
		});

		it(`${name} bounds the retry window`, () => {
			expect(doc).toContain(
				"setTimeout(function () { clearInterval(ryuReadyTimer); }"
			);
		});
	}

	it("installs wheel scrolling in both app bundle paths", () => {
		const pathA = thirdPartyPluginSrcdoc("nonce-wheel-a", "", "com.test.a");
		const pathB = htmlCompanionSrcdoc(
			"nonce-wheel-b",
			"<p>hi</p>",
			"com.test.b"
		);

		expect(pathA).toContain("ryuInstallHorizontalWheelScrolling");
		expect(pathB).toContain("ryuInstallHorizontalWheelScrolling");
		expect(pathA.indexOf("ryuInstallHorizontalWheelScrolling")).toBeLessThan(
			pathA.indexOf("atobUtf8")
		);
	});

	it("emits the versioned envelope from the shared snippet", () => {
		expect(handshakeAnnounceScript()).toContain("hostApiVersion:");
	});

	it("seeds and listens for the complete appearance snapshot on Path A", () => {
		const pathA = thirdPartyPluginSrcdoc(
			"nonce-theme-a",
			"",
			"com.test.theme",
			undefined,
			{
				"--background": "#101114",
				"--ryu-theme-mode": "dark",
				"--ryu-ui-scale": "1.25",
			},
			true
		);
		expect(pathA).toContain("--background: #101114;");
		expect(pathA).toContain('"--ryu-theme-mode":"dark"');
		expect(pathA).toContain('msg.kind !== "ryu-plugin-theme"');
		expect(pathA).toContain("applyThemeTokens(msg.tokens)");
		expect(pathA).toContain("html body{zoom:1 !important;}");
	});
});

// sandbox_never_same_origin
describe("iframe sandbox is locked down", () => {
	it("is exactly allow-scripts and never allow-same-origin", () => {
		expect(IFRAME_SANDBOX).toBe("allow-scripts");
		expect(IFRAME_SANDBOX).not.toContain("allow-same-origin");
	});

	it("enables downloads only for the separately approved app grant", () => {
		expect(APP_DOWNLOAD_GRANT).toBe("files:download");
		expect(sandboxForDownloads(false)).toBe("allow-scripts");
		expect(sandboxForDownloads(true)).toBe("allow-scripts allow-downloads");
	});

	it("keeps forms, popups, and top-navigation disabled by default", () => {
		for (const allowDownloads of [false, true]) {
			const sandbox = sandboxForDownloads(allowDownloads);
			expect(sandbox).not.toContain("allow-same-origin");
			expect(sandbox).not.toContain("allow-popups");
			expect(sandbox).not.toContain("allow-top-navigation");
			expect(sandbox).not.toContain("allow-forms");
		}
	});

	it("allows forms only for an opted-in document with form-action none", () => {
		const appHtml = "<!doctype html><html><body><form></form></body></html>";
		const srcdoc = htmlCompanionSrcdoc(NONCE, appHtml, "@ryu/mail");
		expect(srcdoc).toContain("connect-src 'none'");
		expect(srcdoc).toContain("form-action 'none'");
		expect(sandboxForCompanion({ srcdoc })).toBe("allow-scripts");
		expect(sandboxForCompanion({ allowForms: true, srcdoc })).toBe(
			"allow-scripts allow-forms"
		);
		expect(
			sandboxForCompanion({
				allowDownloads: true,
				allowForms: true,
				srcdoc,
			})
		).toBe("allow-scripts allow-forms allow-downloads");
	});

	it("refuses the forms opt-in unless both network and form actions are blocked", () => {
		for (const srcdoc of [
			"<html><body><form></form></body></html>",
			"<meta http-equiv=\"Content-Security-Policy\" content=\"connect-src 'none'; form-action 'self'\">",
			'<meta http-equiv="Content-Security-Policy" content="connect-src https://api.example; form-action \'none\'">',
		]) {
			expect(sandboxForCompanion({ allowForms: true, srcdoc })).toBe(
				"allow-scripts"
			);
		}
	});

	it("opts in only for first-party compiled HTML bundles", () => {
		expect(shouldEnableCompanionFormEvents(true, true)).toBe(true);
		expect(shouldEnableCompanionFormEvents(true, false)).toBe(false);
		expect(shouldEnableCompanionFormEvents(false, true)).toBe(false);
		expect(shouldEnableCompanionFormEvents(false, false)).toBe(false);
	});

	it("never adds same-origin, popup, or top-navigation permissions with form events", () => {
		const srcdoc = htmlCompanionSrcdoc(
			NONCE,
			"<!doctype html><html><body><form></form></body></html>",
			"@ryu/mail"
		);
		const sandbox = sandboxForCompanion({ allowForms: true, srcdoc });
		expect(sandbox).toContain("allow-forms");
		expect(sandbox).not.toContain("allow-same-origin");
		expect(sandbox).not.toContain("allow-popups");
		expect(sandbox).not.toContain("allow-top-navigation");
	});
});
