import { createRoot } from "react-dom/client";
import { NodeRoutingSettings } from "../../src/components/settings/NodeRoutingSettings.tsx";
import { LOCAL_FALLBACK, useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

const proofNode = { ...LOCAL_FALLBACK, userJwt: "local-proof-user" };
useNodeStore.setState({
	defaultNode: proofNode.name,
	localNodes: [proofNode],
	nodes: [proofNode],
});

const root = document.getElementById("root");
if (!root) {
	throw new Error("Proof root element not found");
}

createRoot(root).render(
	<main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 bg-background px-8 py-10 text-foreground">
		<header className="space-y-2">
			<p className="font-medium text-muted-foreground text-xs uppercase tracking-widest">
				Ryu desktop settings
			</p>
			<h1 className="font-semibold text-2xl">Gateway</h1>
			<p className="max-w-2xl text-muted-foreground text-sm">
				Routing preferences for requests handled by this node and its managed
				Gateway.
			</p>
		</header>
		<NodeRoutingSettings />
	</main>
);
