import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useComposerAgentControls } from "../../components/agent-elements/input/composer-agent-controls.tsx";
import { NodeSelector } from "../../src/components/shell/NodeSelector.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { SystemStatusProvider } from "../../src/contexts/SystemStatusContext.tsx";
import { TabsProvider } from "../../src/contexts/TabsContext.tsx";
import { setInterfaceLevel } from "../../src/lib/interface-level.ts";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import { useGatewayDialog } from "../../src/store/useGatewayDialog.ts";
import { LOCAL_FALLBACK, useNodeStore } from "../../src/store/useNodeStore.ts";
import { useSettingsDialog } from "../../src/store/useSettingsDialog.ts";
import {
	installNodeSelectorFixture,
	type NodeSelectorFixtureSeed,
	ROUTING_PROOF_AGENTS,
} from "./node-selector-proof.mock.ts";
import "../../src/index.css";

// Gateway opens only in Console; grant the access App's ProductModeAccessSync
// would grant a local node.
useProductModeStore.setState({ requestedMode: "console", consoleAccess: true });

const localNode = {
	...LOCAL_FALLBACK,
	token: "local-node-selector-token",
};
const lanNode = {
	name: "lan-box",
	token: "lan-node-selector-token",
	url: "http://lan.fixture:7980",
};
const cloudNode = {
	managed: true,
	name: "cloud-managed",
	orgId: "org-fixture",
	token: null,
	url: "https://managed.fixture:7980",
	userJwt: "cloud-node-fixture-jwt",
};
const suggestions = [
	{
		managed: true,
		name: "cloud-suggested",
		orgId: "org-fixture",
		token: null,
		url: "https://suggested.fixture:7980",
		userJwt: "suggested-node-fixture-jwt",
	},
	{
		managed: true,
		name: "cloud-dismissed",
		orgId: "org-fixture",
		token: null,
		url: "https://dismissed.fixture:7980",
		userJwt: "dismissed-node-fixture-jwt",
	},
];
const seed: NodeSelectorFixtureSeed = {
	cloudNodes: [cloudNode, ...suggestions],
	discoveredNodes: [
		{ latency_ms: 6, profile: "canary", url: "http://10.10.0.8:7980" },
		{ latency_ms: 2, profile: "release", url: lanNode.url },
	],
	localNodes: [localNode, lanNode],
	defaultNode: "local",
	meshEnabled: new URLSearchParams(window.location.search).get("mesh") === "on",
	suggestedCloudNodes: suggestions,
};

interface NodeSelectorWindow extends Window {
	__CLOSE_NODE_SELECTOR_SETTINGS__?: () => void;
	__READ_NODE_SELECTOR_STATE__?: () => {
		autoSelect: boolean;
		autoSelectedNode: string | null;
		defaultNode: string;
		gateway: { open: boolean; section: string };
		localNodes: Array<{ name: string; token: string | null; url: string }>;
		nodes: Array<{
			managed?: boolean;
			name: string;
			token: string | null;
			url: string;
		}>;
		settings: { open: boolean; section: string };
		suggestedCloudNodes: Array<{ name: string; url: string }>;
	};
	__RETRY_NODE_AUTO_SELECT__?: () => Promise<void>;
}

const queryClient = new QueryClient({
	defaultOptions: {
		queries: { refetchOnWindowFocus: false, retry: false },
	},
});

const search = new URLSearchParams(window.location.search);
const reset = search.get("reset") === "true";
installNodeSelectorFixture(reset, seed);
if (reset) {
	search.delete("reset");
	const remaining = search.toString();
	window.history.replaceState(
		null,
		"",
		`${window.location.pathname}${remaining ? `?${remaining}` : ""}`
	);
}
if (search.get("active") === "lan") {
	localStorage.setItem("node-selector-proof-default", lanNode.name);
}
if (search.get("active") === "cloud") {
	localStorage.setItem("node-selector-proof-default", cloudNode.name);
}
if (search.get("offline") === "lan") {
	// SAFETY: This controlled proof health map is seeded with authored true values; the fixture setNodeOnline controls and this offline branch write only the spec's literal booleans. Foreign storage or control mutations are outside this fixture.
	const health = JSON.parse(
		localStorage.getItem("node-selector-proof-health") ?? "{}"
	) as Record<string, boolean>;
	health[lanNode.url] = false;
	localStorage.setItem("node-selector-proof-health", JSON.stringify(health));
}
// SAFETY: The controlled fixture seeds complete local node string fields and string/null tokens; its add_node writer derives strings through pluginStringField and remove_node only filters those parsed native nodes. Foreign storage edits are outside this proof.
const data = JSON.parse(
	localStorage.getItem("node-selector-proof-nodes") ?? "[]"
) as Array<{ name: string; token: string | null; url: string }>;
// SAFETY: This controlled fixture seeds the authored cloudNodes array and never rewrites that storage key afterward; its native string node fields and token values come from the complete seeds above. Foreign storage edits are outside this proof.
const clouds = JSON.parse(
	localStorage.getItem("node-selector-proof-cloud") ?? "[]"
) as typeof seed.cloudNodes;
// SAFETY: The controlled node store persists only string URLs from the native suggestion ids through dismissSuggestion, appending to its filtered restored string list. Foreign storage edits are outside this proof.
const dismissed = JSON.parse(
	localStorage.getItem("ryu:node-dismissed-cloud") ?? "[]"
) as string[];
// SAFETY: This controlled fixture seeds the authored suggestedCloudNodes array and never rewrites that key afterward; all complete suggestion fields are authored above. Foreign storage edits are outside this proof.
const storedSuggestions = JSON.parse(
	localStorage.getItem("node-selector-proof-suggestions") ?? "[]"
) as typeof suggestions;
const normalizeUrl = (url: string) => url.replace(/\/$/, "");
const localUrls = new Set(data.map((node) => normalizeUrl(node.url)));
const storedNodes = [
	...data,
	...clouds.filter((node) => !localUrls.has(normalizeUrl(node.url))),
];
useNodeStore.setState({
	activeNodeOnline: null,
	autoSelect: localStorage.getItem("ryu:node-auto-select") === "true",
	autoSelectedNode: null,
	cloudNodes: clouds,
	defaultNode: localStorage.getItem("node-selector-proof-default") ?? "local",
	dismissedCloudUrls: dismissed,
	localNodes: data,
	nodes: storedNodes,
	suggestedCloudNodes: storedSuggestions.filter(
		(node) =>
			!(
				data.some(
					(existing) => normalizeUrl(existing.url) === normalizeUrl(node.url)
				) || dismissed.includes(normalizeUrl(node.url))
			)
	),
});
const interfaceLevel = search.get("level") === "expert" ? "expert" : "simple";
localStorage.setItem("ryu:interface-level", interfaceLevel);
setInterfaceLevel(interfaceLevel);
useGatewayDialog.setState({ open: false, section: "overview" });
useSettingsDialog.setState({ open: false, section: "general" });
if (useNodeStore.getState().autoSelect) {
	useNodeStore
		.getState()
		.probeAutoSelect()
		.catch(() => undefined);
}
const mode =
	search.get("mode") === "persistent"
		? "persistent-sidebar"
		: "compact-dropdown";

function AgentAutoRoutingComposerProof() {
	const [agentId, setAgentId] = useState<string | null>(null);
	const controls = useComposerAgentControls({
		agents: ROUTING_PROOF_AGENTS,
		atConversationStart: true,
		agentId,
		modelOptions: [],
		model: null,
		onModelChange: () => undefined,
		onSelectAgent: setAgentId,
	});

	return (
		<section
			aria-label="Chat composer"
			className="mx-auto mb-5 max-w-3xl rounded-xl border bg-card p-4"
			data-testid="agent-auto-routing-composer"
		>
			<p className="mb-3 text-muted-foreground text-sm">
				Choose Auto, then configure how each turn is routed.
			</p>
			{controls.leftActions}
			<output className="sr-only" data-testid="selected-agent">
				{agentId ?? "none"}
			</output>
		</section>
	);
}
/* SAFETY: This mutation view writes only this module's three private callbacks; the read callback forwards existing native store fields and does not admit the unchecked storage JSON elsewhere in this fixture. */ (
	window as NodeSelectorWindow
).__READ_NODE_SELECTOR_STATE__ = () => {
	const node = useNodeStore.getState();
	const gateway = useGatewayDialog.getState();
	const settings = useSettingsDialog.getState();
	return {
		autoSelect: node.autoSelect,
		autoSelectedNode: node.autoSelectedNode,
		defaultNode: node.defaultNode,
		gateway: { open: gateway.open, section: gateway.section },
		localNodes: structuredClone(node.localNodes),
		nodes: structuredClone(node.nodes),
		settings: { open: settings.open, section: settings.section },
		suggestedCloudNodes: structuredClone(node.suggestedCloudNodes),
	};
};
/* SAFETY: This mutation view writes only this module's three private callbacks; the read callback forwards existing native store fields and does not admit the unchecked storage JSON elsewhere in this fixture. */ (
	window as NodeSelectorWindow
).__RETRY_NODE_AUTO_SELECT__ = async () => {
	await useNodeStore.getState().probeAutoSelect();
};
/* SAFETY: This mutation view writes only this module's three private callbacks; the read callback forwards existing native store fields and does not admit the unchecked storage JSON elsewhere in this fixture. */ (
	window as NodeSelectorWindow
).__CLOSE_NODE_SELECTOR_SETTINGS__ = () => {
	useSettingsDialog.getState().setOpen(false);
};

function ProofSurface() {
	return (
		<I18nProvider>
			<ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
				<QueryClientProvider client={queryClient}>
					<EntitlementProvider>
						<TabsProvider>
							<SystemStatusProvider>
								<AppSurfaceProvider surface="desktop">
									<main className="min-h-screen bg-background p-8 text-foreground">
										<header className="mx-auto mb-5 max-w-3xl">
											<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
												RYU · NODE SELECTOR PROOF
											</p>
											<h1 className="mt-2 font-semibold text-2xl">
												Node selector
											</h1>
											<p className="mt-1 text-muted-foreground text-sm">
												Production NodeSelector with local node, Core, Tauri,
												billing, clipboard, and connection fixtures.
											</p>
										</header>
										{search.get("agentAuto") === "true" ? (
											<AgentAutoRoutingComposerProof />
										) : null}
										<div
											className="mx-auto max-w-3xl rounded-xl border bg-sidebar p-4"
											data-testid="node-selector-surface"
										>
											<NodeSelector mode={mode} />
										</div>
									</main>
									<Toaster position="bottom-right" theme="dark" />
								</AppSurfaceProvider>
							</SystemStatusProvider>
						</TabsProvider>
					</EntitlementProvider>
				</QueryClientProvider>
			</ThemeProvider>
		</I18nProvider>
	);
}

document.documentElement.classList.add("dark");
const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing root");
}
createRoot(root).render(<ProofSurface />);
