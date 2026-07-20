// Mounts a THIRD-PARTY plugin's bundled UI through `@ryu/app-host`'s sandboxed,
// null-origin iframe on the island surface, gated by the plugin's GATEWAY-APPROVED
// grants. Island port of the desktop `PluginHostPanel`.
//
// The one structural difference from desktop is transport: island's renderer
// cannot reach Core directly (CORS excludes Electron origins), so the trusted host
// services delegate to the `window.island.plugins.*` IPC methods (the main process
// holds the node token; the plugin frame never does). It:
//   - fetches the plugin's bundled code over IPC (keyed by the OWNING plugin id),
//   - builds the granted capability set from the plugin's Gateway-approved grants
//     (deny-safe: an empty approved list yields an empty capability set),
//   - implements the privileged host services (listAgents projected to `{id,name}`;
//     registerRoute scoped to this plugin's own surface; the 6 host-bridge services
//     + runAgentStream via the island transport, keyed by `companion.pluginId`), and
//   - wraps the frame in a visible "App" attribution header so it is never mistaken
//     for system chrome.
//
// Renders nothing runnable unless the companion carries a UI bundle (`hasUi`).

import { ExtensionHost } from "@ryu/app-host/ExtensionHost";
import {
	type Capability,
	capabilitiesFromGrants,
	type HostServices,
	validatePluginRoute,
} from "@ryu/app-host/rpc";
import { thirdPartyPluginSrcdoc } from "@ryu/app-host/third-party-plugin";
import { useEffect, useMemo, useState } from "react";
import type { PluginCompanion } from "../../shared/ipc.ts";
import {
	pluginHostInvoke,
	pluginHostInvokeStream,
} from "./island-plugin-host-invoke.ts";

/** Base64-encode a UTF-8 string (btoa is Latin-1 only). Inlines the plugin bundle
 *  into the sandboxed `srcdoc` so a body containing `</script>` cannot break the
 *  tag (defense in depth; the sandbox is the real boundary). */
function toBase64Utf8(input: string): string {
	const bytes = new TextEncoder().encode(input);
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

type BundleState =
	| { status: "loading" }
	| { status: "ready"; code: string | null }
	| { status: "error" };

export function IslandPluginHost({
	companion,
}: {
	companion: PluginCompanion;
}) {
	const [connected, setConnected] = useState(false);
	const [bundle, setBundle] = useState<BundleState>({ status: "loading" });

	// Fetch the plugin's bundled code over IPC (the main process holds the token).
	// Keyed by the OWNING plugin id (the store key), not the companion id.
	useEffect(() => {
		let cancelled = false;
		setBundle({ status: "loading" });
		window.island.plugins
			.uiBundle(companion.pluginId)
			.then((result) => {
				if (cancelled) {
					return;
				}
				setBundle(
					result.available
						? { status: "ready", code: result.code }
						: { status: "error" }
				);
			})
			.catch(() => {
				if (!cancelled) {
					setBundle({ status: "error" });
				}
			});
		return () => {
			cancelled = true;
		};
	}, [companion.pluginId]);

	// One nonce per mount. Host-generated, never plugin/user input.
	const nonce = useMemo(
		() =>
			typeof crypto?.randomUUID === "function"
				? crypto.randomUUID()
				: `nonce-${Date.now()}-${Math.round(Math.random() * 1e9)}`,
		[]
	);

	// The granted set comes from the plugin's GATEWAY-APPROVED grants. DENY-SAFE: an
	// empty approved list yields an empty set (the plugin can call nothing).
	const granted = useMemo<ReadonlySet<Capability>>(
		() => capabilitiesFromGrants(companion.approvedGrants),
		[companion.approvedGrants]
	);

	// The privileged services. `listAgents` returns a minimal `{id,name}` projection
	// over IPC; `registerRoute` accepts ONLY this plugin's own `/plugin/<id>` path
	// (anti-phishing); the host-bridge services delegate to the island transport,
	// keyed by the OWNING plugin id (`companion.pluginId`, NOT `companion.id`).
	const services = useMemo<HostServices>(
		() => ({
			listAgents: async () => {
				const result = await window.island.core.agents();
				if (!result.available) {
					return [];
				}
				return result.agents.map((a) => ({ id: a.id, name: a.name }));
			},
			registerRoute: (claim) => {
				if (!validatePluginRoute(companion.id, claim)) {
					return Promise.reject(
						new Error(`route '${claim.path}' is not this plugin's own surface`)
					);
				}
				return Promise.resolve({ path: claim.path });
			},
			modelComplete: (input) =>
				pluginHostInvoke(
					companion.pluginId,
					"model.complete",
					input
				) as Promise<string>,
			runAgent: (input) =>
				pluginHostInvoke(
					companion.pluginId,
					"agent.run",
					input
				) as Promise<string>,
			storageGet: (input) =>
				pluginHostInvoke(companion.pluginId, "storage.get", input) as Promise<
					string | null
				>,
			storageSet: async (input) => {
				await pluginHostInvoke(companion.pluginId, "storage.set", input);
			},
			storageDelete: async (input) => {
				await pluginHostInvoke(companion.pluginId, "storage.delete", input);
			},
			storageKeys: (input) =>
				pluginHostInvoke(companion.pluginId, "storage.keys", input) as Promise<
					string[]
				>,
			runAgentStream: (input, emit, signal) =>
				pluginHostInvokeStream(companion.pluginId, input, {
					onChunk: emit,
					signal,
				}),
		}),
		[companion.id, companion.pluginId]
	);

	const srcdoc = useMemo(
		() =>
			bundle.status === "ready" && bundle.code
				? thirdPartyPluginSrcdoc(nonce, toBase64Utf8(bundle.code), companion.id)
				: null,
		[bundle, nonce, companion.id]
	);

	if (bundle.status === "loading") {
		return (
			<div className="flex h-full items-center justify-center p-6 text-neutral-400 text-sm">
				Loading app…
			</div>
		);
	}

	if (!srcdoc) {
		return (
			<div className="flex h-full items-center justify-center p-6 text-neutral-400 text-sm">
				This app does not provide a runnable UI.
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col overflow-hidden">
			{/* Visible attribution: this is app content, namespaced, never system
			    chrome. */}
			<div className="flex items-center gap-2 border-white/10 border-b bg-white/5 px-3 py-2">
				<span className="font-medium text-neutral-200 text-sm">
					App · {companion.label || companion.name}
				</span>
				<span className="ml-auto text-neutral-500 text-xs">
					{connected ? "sandboxed · connected" : "sandboxed · starting…"}
				</span>
			</div>
			<div className="min-h-0 flex-1">
				<ExtensionHost
					granted={granted}
					nonce={nonce}
					onConnected={() => setConnected(true)}
					services={services}
					srcdoc={srcdoc}
					title={`App: ${companion.name}`}
				/>
			</div>
		</div>
	);
}
