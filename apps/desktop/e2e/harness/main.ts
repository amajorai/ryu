// Browser harness for the REAL plugin-runtime security certificate
// (`e2e/plugin-runtime.spec.ts`). Served by Vite, loaded into real Chromium by
// Playwright. It mounts the ACTUAL `<ExtensionHost>` React component with the
// ACTUAL `thirdPartyPluginSrcdoc` bootstrap and the ACTUAL capability-gated
// `dispatchRpc` host services — nothing here is a reimplementation of the security
// boundary. The Playwright spec injects benign/malicious plugin bundles through
// `window.__ryuCert.mount(...)` and reads back both the host-side log and the
// in-iframe error surface.
//
// Why a harness and not the running desktop: the security boundary (null-origin
// sandbox + per-document CSP) is a property of the browser, reproducible in a bare
// page. Driving it here keeps the cert hermetic (no Core node, no Tauri) while
// still exercising the real host code path end to end.
//
// The host code it certifies lives in `packages/app-host` (`@ryu/app-host/*`) —
// the same modules the desktop itself imports (PluginHostPanel, AppWidget). Import
// them from the package, never from a copy: a harness that certifies a fork of the
// boundary certifies nothing.

import { ExtensionHost } from "@ryu/app-host/ExtensionHost";
import {
	type Capability,
	capabilitiesFromGrants,
	type HostServices,
	type RouteClaim,
	validatePluginRoute,
} from "@ryu/app-host/rpc";
import { thirdPartyPluginSrcdoc } from "@ryu/app-host/third-party-plugin";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

/** Base64-encode a UTF-8 string, matching `PluginHostPanel.toBase64Utf8` so the
 *  bundle is inlined into `srcdoc` exactly as production does it. */
function toBase64Utf8(input: string): string {
	const bytes = new TextEncoder().encode(input);
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

/** A host-observed event, surfaced to the Playwright spec via
 *  `window.__ryuCert.hostLog`. */
interface HostEvent {
	accepted?: boolean;
	claim?: RouteClaim;
	returned?: unknown;
	type: "connected" | "listAgents" | "registerRoute";
}

interface MountOptions {
	/** Optional agent records the host projects to `{id,name}`; a `secret` field
	 *  here proves the projection never leaks it. */
	agents?: Array<{ id: string; name: string; secret?: string }>;
	/** Gateway-approved grant strings → mapped to capabilities by the real
	 *  `capabilitiesFromGrants` (deny-safe on unknown grants). */
	grants: string[];
	/** The owning plugin id, baked into the trusted bootstrap + re-validated host-side. */
	pluginId: string;
	/** The plugin bundle source (an activate()-exporting body). Encoded to base64
	 *  and inlined by the real bootstrap. */
	uiCode: string;
}

interface CertApi {
	hostLog: HostEvent[];
	mount: (options: MountOptions) => void;
	sandboxAttr: () => string | null;
}

const hostLog: HostEvent[] = [];
let root: Root | null = null;

const DEFAULT_AGENTS: NonNullable<MountOptions["agents"]> = [
	{ id: "ryu", name: "Ryu", secret: "node-token-should-never-leak" },
];

function mount(options: MountOptions): void {
	hostLog.length = 0;
	const nonce =
		typeof crypto?.randomUUID === "function"
			? crypto.randomUUID()
			: `nonce-${Date.now()}`;
	const granted: ReadonlySet<Capability> = capabilitiesFromGrants(
		options.grants
	);
	const agents = options.agents ?? DEFAULT_AGENTS;

	// The REAL privileged host services: `listAgents` projects to {id,name} only
	// (never the token/secret), `registerRoute` is pluginId-scoped anti-phishing.
	const services: HostServices = {
		listAgents: () => {
			const projected = agents.map((a) => ({ id: a.id, name: a.name }));
			hostLog.push({ type: "listAgents", returned: projected });
			return Promise.resolve(projected);
		},
		registerRoute: (claim: RouteClaim) => {
			const accepted = validatePluginRoute(options.pluginId, claim);
			hostLog.push({ type: "registerRoute", claim, accepted });
			return accepted
				? Promise.resolve({ path: claim.path })
				: Promise.reject(
						new Error(`route '${claim.path}' is not this plugin's own surface`)
					);
		},
	};

	const srcdoc = thirdPartyPluginSrcdoc(
		nonce,
		toBase64Utf8(options.uiCode),
		options.pluginId
	);

	const container = document.getElementById("host-root");
	if (!container) {
		throw new Error("harness #host-root missing");
	}
	if (root) {
		root.unmount();
	}
	root = createRoot(container);
	root.render(
		createElement(ExtensionHost, {
			srcdoc,
			nonce,
			granted,
			services,
			onConnected: () => hostLog.push({ type: "connected" }),
			title: "Cert",
		})
	);
}

function sandboxAttr(): string | null {
	return document.querySelector("iframe")?.getAttribute("sandbox") ?? null;
}

const api: CertApi = { hostLog, mount, sandboxAttr };
(window as unknown as { __ryuCert: CertApi }).__ryuCert = api;

// Signal readiness so the spec can wait deterministically.
document.body.setAttribute("data-harness-ready", "1");
