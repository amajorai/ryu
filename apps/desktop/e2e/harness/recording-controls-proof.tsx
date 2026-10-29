import { HotkeysProvider } from "@ryu/hotkeys/react";
import { I18nProvider } from "@ryu/i18n/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext } from "react";
import { createRoot } from "react-dom/client";
import { AssistantDock } from "../../src/components/assistant/AssistantDock.tsx";
import { AssistantPanel } from "../../src/components/assistant/AssistantPanel.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { DESKTOP_HOTKEYS } from "../../src/lib/hotkeys/actions.ts";
import { useAssistantStore } from "../../src/store/useAssistantStore.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { useWorkspaceStore } from "../../src/store/useWorkspaceStore.ts";
import "../../src/index.css";
const fixtureNode = {
	name: "Fixture node",
	url: window.location.origin,
	token: "fixture-node-token",
	userJwt: null,
};
useNodeStore.setState({ getActiveNode: () => fixtureNode });

export {
	useIsActiveTab,
	useTabsContext,
} from "./assistant-panel-proof.mock.tsx";
export const TabsContext = createContext(null);
const agents = [
	{
		id: "ryu",
		name: "Ryu",
		engine: "local",
		transport: "openai_compat",
		recommended: true,
		builtIn: true,
		lifecycleStatus: "active",
		description: "Workspace assistant",
	},
	{
		id: "proof-agent",
		name: "Review Agent",
		engine: "codex",
		transport: "acp",
		recommended: false,
		builtIn: true,
		lifecycleStatus: "active",
		description: "Review workspace changes",
	},
];
// The registry and active-node boundaries are deterministic. Composer bindings,
// picker body, ACP derivation, runtime persistence and transport remain production.
export function useAgents() {
	return { agents, loading: false, error: null };
}
export function useActiveNode() {
	return {
		url: window.location.origin,
		token: "fixture-node-token",
		userJwt: null,
	};
}
// The real getter resolves the store's active node, which this fixture pins.
function getFixtureNode() {
	return fixtureNode;
}
export function useActiveNodeGetter() {
	return getFixtureNode;
}
export function useEntitlementContext() {
	return {
		verdict: null,
		ready: true,
		canUse: () => true,
		requestUpgrade: () => {},
		refresh: async () => {},
	};
}
window.__assistantProof = { calls: [], history: {} };
Object.assign(window, {
	assistantStore: useAssistantStore,
	workspaceStore: useWorkspaceStore,
	switchRecordingNode: (token: string | null) => {
		const nextNode = { ...fixtureNode, token };
		useNodeStore.setState({ getActiveNode: () => nextNode });
	},
});
document.documentElement.classList.add("dark");
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
function Story() {
	const mode = useAssistantStore((state) => state.mode);
	return (
		<main className="min-h-svh bg-background p-8 text-foreground">
			<h1 className="text-2xl">Workspace</h1>
			<button
				onClick={() => useAssistantStore.getState().open("sidebar")}
				type="button"
			>
				Open workspace assistant
			</button>
			<p className="mt-2 text-muted-foreground">
				Ask Ryu about your current workspace.
			</p>
			{mode === "sidebar" && <AssistantPanel />}
			<AssistantDock />
		</main>
	);
}
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={queryClient}>
		<AppSurfaceProvider surface="desktop">
			<I18nProvider>
				<HotkeysProvider registry={DESKTOP_HOTKEYS}>
					<Story />
				</HotkeysProvider>
			</I18nProvider>
		</AppSurfaceProvider>
	</QueryClientProvider>
);
