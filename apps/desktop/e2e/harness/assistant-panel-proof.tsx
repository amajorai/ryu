import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { AssistantDock } from "../../src/components/assistant/AssistantDock.tsx";
import { AssistantPanel } from "../../src/components/assistant/AssistantPanel.tsx";
import { useAssistantBuilder } from "../../src/hooks/useAssistantBuilder.ts";
import { useAssistantPageContext } from "../../src/hooks/useAssistantPageContext.ts";
import { useAssistantStore } from "../../src/store/useAssistantStore.ts";
import { useWorkspaceStore } from "../../src/store/useWorkspaceStore.ts";
import "../../src/index.css";
window.__assistantProof = { calls: [], history: {} };
Object.assign(window, {
	assistantStore: useAssistantStore,
	workspaceStore: useWorkspaceStore,
});
document.documentElement.classList.add("dark");
function BuilderCaller() {
	useAssistantBuilder({
		kind: "dashboard",
		label: "Build Workspace board",
		description: "Assemble this board.",
		targetId: null,
		targetName: "Workspace board",
		snapshot: "{widgets:[]}",
		preamble: "Build {{targetId}} from {{snapshot}}",
		prompts: ["Tidy the layout"],
		resolveId: async () => {
			window.__assistantProof.calls.push({ kind: "resolve" });
			return "board-proof";
		},
		onChanged: (id) => {
			window.__assistantProof.calls.push({ kind: "changed", id });
		},
	});
	return null;
}
function PageContextCaller() {
	useAssistantPageContext({
		id: "document:brief",
		title: "Current brief",
		text: "Workspace brief snapshot",
	});
	return null;
}
function Story() {
	const mode = useAssistantStore((s) => s.mode);
	return (
		<main className="min-h-svh bg-background p-8 text-foreground">
			{new URLSearchParams(location.search).has("builder") && <BuilderCaller />}
			{new URLSearchParams(location.search).has("context") && (
				<PageContextCaller />
			)}
			<h1 className="text-2xl">Workspace</h1>
			<p className="mt-2 text-muted-foreground">
				Ask Ryu about your current workspace.
			</p>
			{mode === "sidebar" && <AssistantPanel />}
			<AssistantDock />
		</main>
	);
}
// The desktop shell mounts the panel under its QueryClientProvider; the panel's
// generative-UI state host reads through that client.
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={queryClient}>
		<Story />
	</QueryClientProvider>
);
