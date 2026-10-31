// The props contract of `ExtensionHost`, split from the component so the file
// stays within the source-size limit. `ExtensionHost.tsx` re-exports it.

import type { RefObject } from "react";
import type { ExtensionFrameMessage } from "./extension-host-handshake.ts";
import type { Capability, HostPush, HostServices } from "./rpc.ts";

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
	/**
	 * Optional URL of a declared sandbox page that loads `srcdoc` itself. A host
	 * surface whose own CSP forbids inline script (the MV3 extension dashboard)
	 * cannot use `about:srcdoc`, which inherits that policy; it passes its sandbox
	 * page here instead. The page answers `ryu-sandbox-ready`, receives `srcdoc`
	 * once, and writes it over itself, after which the ordinary nonce + source
	 * handshake and grant-gated port run unchanged. Omitted on desktop and web.
	 */
	sandboxPage?: string;
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
