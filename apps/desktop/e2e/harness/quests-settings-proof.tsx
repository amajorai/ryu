import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { createRoot } from "react-dom/client";
import { QuestsSettings } from "../../src/components/settings/QuestsSettings.tsx";
import type { Node } from "../../src/store/useNodeStore.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

const fixtureNode: Node = {
	name: "quests-settings-proof-node",
	token: "quests-settings-proof-token",
	url: window.location.origin,
	userJwt: "quests-settings-proof-user-jwt",
};

useNodeStore.setState({
	cloudNodes: [],
	defaultNode: fixtureNode.name,
	localNodes: [fixtureNode],
	nodes: [fixtureNode],
});

const root = document.getElementById("root");
if (!root) {
	throw new Error("Quests settings proof root was not found");
}

createRoot(root).render(
	<main className="dark min-h-screen bg-background px-8 py-6 text-foreground">
		<div className="mx-auto max-w-3xl space-y-6">
			<header className="rounded-xl border bg-card p-6 shadow-sm">
				<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
					Production QuestsSettings · stateful local Core fixture
				</p>
				<h1 className="mt-2 font-semibold text-2xl">Quests settings</h1>
				<p className="mt-2 text-muted-foreground text-sm">
					All node configuration requests use the isolated local fixture.
				</p>
			</header>
			<QuestsSettings />
			<Toaster position="bottom-right" theme="dark" />
		</div>
	</main>
);
