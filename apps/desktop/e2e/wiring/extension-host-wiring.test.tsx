// DOM WIRING test for <ExtensionHost> — NOT a security certificate.
//
// ⚠️  READ THIS BEFORE TREATING ANY ASSERTION HERE AS A SECURITY GUARANTEE ⚠️
//
// This file runs under happy-dom (a JS DOM shim), which enforces **no** Content
// Security Policy and **no** real cross-origin/null-origin isolation. It therefore
// CANNOT prove the load-bearing sandbox invariants — CSP `connect-src 'none'`
// egress blocking and null-origin `window.parent.document` isolation. Asserting
// those here would be security theatre. The REAL browser certificate for those
// lives in `e2e/plugin-runtime.spec.ts` (Playwright + real Chromium), which is the
// gate CI runs.
//
// What this DOES prove — the DOM WIRING that the pure predicates
// (`shouldTransferPort`, `IFRAME_SANDBOX`) can't observe on their own, by mounting
// the REAL `<ExtensionHost>` React component:
//   1. it renders an <iframe> whose `sandbox` attribute is EXACTLY `IFRAME_SANDBOX`
//      (`"allow-scripts"`, never `allow-same-origin`);
//   2. it drives the frame via `srcDoc` and NEVER sets `src` (no navigable origin);
//   3. its handshake transfers the RPC port ONLY to a "ready" whose
//      `event.source === iframe.contentWindow` and whose nonce matches — a spoofed
//      `event.source` gets nothing (the `shouldTransferPort` gate, live in the
//      mounted component, not a reimplementation).
//
// It lives OUTSIDE `src/contributions/host/` in its own dir so the happy-dom global
// registration here never clobbers the native `MessageChannel`/`MessageEvent` the
// host suite (adversarial/handshake/bridge) depends on. Run it path-scoped:
//   bun test e2e/wiring/

import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Register the DOM shim BEFORE react-dom renders. Import order: this statement
// runs at module-eval time; react-dom only touches `document` at render (inside
// the `it` blocks), by which point the shim is live.
GlobalRegistrator.register();

import { afterEach, describe, expect, it } from "bun:test";
import { ExtensionHost, IFRAME_SANDBOX } from "@ryu/app-host/ExtensionHost";
import type { HostServices } from "@ryu/app-host/rpc";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

// React's `act` needs this flag set so effects flush inside `await act(...)`.
(
	globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NONCE = "wiring-nonce-abc";

/** Minimal host services — never exercised here (no real handshake completes in a
 *  shim), only supplied to satisfy the component contract. */
function stubServices(): HostServices {
	return {
		listAgents: () => Promise.resolve([]),
		registerRoute: () => Promise.resolve({}),
	};
}

let currentRoot: Root | null = null;
let currentContainer: HTMLElement | null = null;

async function mountHost(): Promise<HTMLIFrameElement> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	currentContainer = container;
	const root = createRoot(container);
	currentRoot = root;
	await act(async () => {
		root.render(
			createElement(ExtensionHost, {
				srcdoc: "<!doctype html><body>wiring</body>",
				nonce: NONCE,
				granted: new Set(),
				services: stubServices(),
				title: "Wiring",
			})
		);
	});
	const iframe = container.querySelector("iframe");
	if (!iframe) {
		throw new Error("ExtensionHost did not render an iframe");
	}
	return iframe;
}

afterEach(async () => {
	if (currentRoot) {
		await act(async () => {
			currentRoot?.unmount();
		});
		currentRoot = null;
	}
	currentContainer?.remove();
	currentContainer = null;
});

describe("ExtensionHost DOM wiring (NOT a security cert — no CSP, no real origin)", () => {
	it("renders an iframe whose sandbox is EXACTLY IFRAME_SANDBOX (allow-scripts, no allow-same-origin)", async () => {
		const iframe = await mountHost();
		const sandbox = iframe.getAttribute("sandbox");
		expect(sandbox).toBe(IFRAME_SANDBOX);
		expect(sandbox).toBe("allow-scripts");
		expect(sandbox).not.toContain("allow-same-origin");
	});

	it("drives the frame via srcDoc and NEVER sets src", async () => {
		const iframe = await mountHost();
		expect(iframe.hasAttribute("srcdoc")).toBe(true);
		expect(iframe.hasAttribute("src")).toBe(false);
		expect(iframe.getAttribute("src")).toBeNull();
	});

	it("transfers the RPC port ONLY for a ready from THIS frame with the right nonce", async () => {
		const iframe = await mountHost();
		const contentWindow = iframe.contentWindow;
		if (!contentWindow) {
			throw new Error("iframe.contentWindow was null under the DOM shim");
		}

		// Spy on the frame's postMessage: a transferred port shows up here.
		const posts: Array<{ data: unknown; ports: readonly MessagePort[] }> = [];
		const originalPostMessage = contentWindow.postMessage.bind(contentWindow);
		(
			contentWindow as unknown as { postMessage: (...a: unknown[]) => void }
		).postMessage = (data: unknown, _target?: unknown, transfer?: unknown) => {
			posts.push({
				data,
				ports: (transfer as MessagePort[] | undefined) ?? [],
			});
		};

		const ready = { kind: "ryu-plugin-ready", nonce: NONCE };

		// (1) SPOOFED source: a valid-looking ready whose source is NOT the frame.
		// The live `shouldTransferPort` gate in the component must refuse it.
		await act(async () => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: ready,
					source: window as unknown as Window,
				})
			);
		});
		expect(posts.length).toBe(0);

		// (2) SPOOFED nonce from the real frame: also refused.
		await act(async () => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { kind: "ryu-plugin-ready", nonce: "WRONG" },
					source: contentWindow,
				})
			);
		});
		expect(posts.length).toBe(0);

		// (3) LEGIT ready from THIS frame with the right nonce: the port is
		// transferred exactly once, tagged with the nonce.
		await act(async () => {
			window.dispatchEvent(
				new MessageEvent("message", { data: ready, source: contentWindow })
			);
		});
		expect(posts.length).toBe(1);
		expect(posts[0]?.ports.length).toBe(1);
		expect(posts[0]?.data).toMatchObject({
			kind: "ryu-plugin-host-port",
			nonce: NONCE,
		});

		// (4) STOLEN-port replay: a second ready after connect mints NO second port.
		await act(async () => {
			window.dispatchEvent(
				new MessageEvent("message", { data: ready, source: contentWindow })
			);
		});
		expect(posts.length).toBe(1);

		// restore (defensive; afterEach unmounts anyway)
		(
			contentWindow as unknown as { postMessage: (...a: unknown[]) => void }
		).postMessage = originalPostMessage as (...a: unknown[]) => void;
	});
});
