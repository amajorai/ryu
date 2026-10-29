import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
// Browser harness for the PATH-B companion certificate
// (`e2e/companion-host.spec.ts`). Path A (an ESM bundle eval'd through
// `thirdPartyPluginSrcdoc`) already has a certificate — `plugin-runtime.spec.ts`
// plus `harness/main.ts`. Path B, the one every shipped app actually uses
// (`ui_format: "html"` → `htmlCompanionSrcdoc` → a `vite-plugin-singlefile`
// bundle mounted straight as `srcdoc`), had none, so a regression in that
// handshake shipped green.
//
// It mounts the REAL `<ExtensionHost>` with the REAL `htmlCompanionSrcdoc`
// wrapper — never a copy — and records BOTH halves of the handshake so a failure
// says which half broke:
//   - every `window.message` the parent receives (did the frame ever announce?)
//   - the `onConnected` callback (did the host accept and transfer the port?)
// The spec feeds it the actual `apps/core/src/plugin_manifest/fixtures/*.ui.html`
// bytes — the same bundle Core serves — because the pre-existing unit test wraps
// `"<p>hi</p>"`, which is exactly why a real-bundle failure passed everything.

import {
	COMPANION_THEME_MUTATION_ATTRIBUTES,
	readCompanionThemeTokens,
} from "@ryu/app-host/companion-theme";
import { APP_DOWNLOAD_GRANT, ExtensionHost } from "@ryu/app-host/ExtensionHost";
import {
	type Capability,
	capabilitiesFromGrants,
	type HostServices,
	validatePluginRoute,
} from "@ryu/app-host/rpc";
import { htmlCompanionSrcdoc } from "@ryu/app-host/third-party-plugin";
import { Toaster, toast } from "@ryu/ui/components/sileo.tsx";
import { type ComponentProps, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	createScopedToastHost,
	createSileoToastRenderer,
} from "../../../../packages/app-host/src/toast-host.ts";

interface MountOptions {
	/** The app's self-contained HTML bundle (a real fixture's bytes). */
	appHtml: string;
	/** Gateway-approved grant strings → real `capabilitiesFromGrants`. */
	grants: string[];
	/** The owning plugin id, baked into the bridge. */
	pluginId: string;
}

interface CompanionApi {
	/** Every `kind` seen on a window message, in order. */
	announced: string[];
	/** Set once the host accepted a handshake and transferred the port. */
	connected: () => boolean;
	mount: (options: MountOptions) => void;
	/** The composed srcdoc, so the spec can assert the injection landed. */
	srcdoc: () => string;
}

const announced: string[] = [];
let connected = false;
let lastSrcdoc = "";
let root: Root | null = null;
let toastHost = createScopedToastHost({
	renderer: createSileoToastRenderer(toast),
	sourceId: "@ryu/companion-host-story",
});

// Record EVERY inbound window message, not just the accepted one: a `ready` that
// arrives and is rejected (nonce mismatch) is a completely different bug from a
// `ready` that never arrives (the frame's bridge script never ran).
window.addEventListener("message", (event: MessageEvent) => {
	const kind: unknown = event.data?.kind;
	if (isNativeText(kind)) {
		announced.push(kind);
	}
});

function mount(options: MountOptions): void {
	toastHost.dispose();
	toastHost = createScopedToastHost({
		renderer: createSileoToastRenderer(toast),
		sourceId: options.pluginId,
	});
	announced.length = 0;
	connected = false;
	const nonce = crypto.randomUUID();
	const granted: ReadonlySet<Capability> = capabilitiesFromGrants(
		options.grants
	);
	// Path B apps drive Core through host-side verbs. This cert is about the
	// handshake, not the verbs, so only the two REQUIRED members are implemented —
	// the rest are optional, and an unbound call replies with an error over the same
	// live port, exactly as it would in the shell.
	const services: HostServices = {
		listAgents: () => Promise.resolve([]),
		uiToastDismiss: (input) => toastHost.dismiss(input),
		uiToastShow: (input) => toastHost.show(input),
		uiToastUpdate: (input) => toastHost.update(input),
		registerRoute: (claim) =>
			validatePluginRoute(options.pluginId, claim)
				? Promise.resolve({ path: claim.path })
				: Promise.reject(
						new Error(`route '${claim.path}' is not this plugin's own surface`)
					),
	};

	lastSrcdoc = htmlCompanionSrcdoc(
		nonce,
		options.appHtml,
		options.pluginId,
		undefined,
		undefined,
		readCompanionThemeTokens()
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
		createElement(
			"div",
			{ style: { minHeight: 360, padding: 24 } },
			createElement(ThemeAwareExtensionHost, {
				srcdoc: lastSrcdoc,
				nonce,
				granted,
				allowDownloads: options.grants.includes(APP_DOWNLOAD_GRANT),
				services,
				onConnected: () => {
					connected = true;
				},
				title: "Companion cert",
			}),
			createElement(Toaster, { position: "bottom-right" })
		)
	);
}

function ThemeAwareExtensionHost(props: ComponentProps<typeof ExtensionHost>) {
	const [themeTokens, setThemeTokens] = useState(readCompanionThemeTokens);
	useEffect(() => {
		const observer = new MutationObserver(() =>
			setThemeTokens(readCompanionThemeTokens())
		);
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: [...COMPANION_THEME_MUTATION_ATTRIBUTES],
		});
		return () => observer.disconnect();
	}, []);
	return createElement(ExtensionHost, { ...props, themeTokens });
}

const api: CompanionApi = {
	announced,
	connected: () => connected,
	mount,
	srcdoc: () => lastSrcdoc,
};
/* SAFETY: This assignment publishes the complete locally checked CompanionApi value on the native browser Window under __ryuCompanion. The view owns only that publication slot; it makes no claim about plugin messages or native SDK members. */ (
	window as typeof window & { __ryuCompanion: CompanionApi }
).__ryuCompanion = api;

document.body.setAttribute("data-harness-ready", "1");
