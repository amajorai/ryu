// Mounts the built-in EXAMPLE plugin (#446) through the extension host to prove
// the sandboxed-iframe + capability-gated-bridge loop end to end inside the real
// desktop. Reachable from the Extensions page.
//
// This is the trusted-webview side: it owns the Core node token, generates the
// per-mount nonce, declares which capabilities the example plugin is granted, and
// implements the privileged `listAgents` service. The plugin (in the iframe) sees
// none of that: it only gets RPC results for granted methods.

import { useMemo, useState } from "react";
import { fetchAgents } from "@/src/lib/api/agents.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import { ExtensionHost } from "@ryu/app-host/ExtensionHost";
import { examplePluginSrcdoc } from "@ryu/app-host/example-plugin";
import type { Capability, HostServices } from "@ryu/app-host/rpc";

export function ExamplePluginPanel() {
	const getActiveNode = useNodeStore((s) => s.getActiveNode);
	const [connected, setConnected] = useState(false);

	// One nonce per mount. Host-generated, never plugin/user input.
	const nonce = useMemo(
		() =>
			typeof crypto?.randomUUID === "function"
				? crypto.randomUUID()
				: `nonce-${Date.now()}-${Math.round(Math.random() * 1e9)}`,
		[]
	);
	const srcdoc = useMemo(() => examplePluginSrcdoc(nonce), [nonce]);

	// The capabilities the host grants this example. MVP: host-provided config
	// (reading from manifest.json grants is #443).
	const granted = useMemo<ReadonlySet<Capability>>(
		() => new Set<Capability>(["core.listAgents"]),
		[]
	);

	// The privileged service: the host holds the token and does the fetch.
	const services = useMemo<HostServices>(
		() => ({
			listAgents: async () => {
				const node = getActiveNode();
				const agents = await fetchAgents(toTarget(node));
				// Hand the plugin only a minimal projection (no internal fields).
				return agents.map((a) => ({ id: a.id, name: a.name }));
			},
			// The built-in demo does not claim its own route; reject any attempt so
			// the HostServices contract is satisfied without granting a surface.
			registerRoute: () =>
				Promise.reject(new Error("example plugin does not register routes")),
		}),
		[getActiveNode]
	);

	return (
		<div className="flex h-full flex-col overflow-hidden rounded-lg bg-card">
			<div className="flex items-center justify-between border-b px-3 py-2">
				<div className="font-medium text-sm">Example plugin (sandboxed)</div>
				<span className="text-muted-foreground text-xs">
					{connected ? "bridge connected" : "starting…"}
				</span>
			</div>
			<div className="min-h-0 flex-1">
				<ExtensionHost
					granted={granted}
					nonce={nonce}
					onConnected={() => setConnected(true)}
					services={services}
					srcdoc={srcdoc}
					title="Example plugin"
				/>
			</div>
		</div>
	);
}
