import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { AgentCalendarView } from "@/src/components/agents/AgentCalendarView.tsx";
import { AppSurfaceProvider } from "@/src/contexts/app-surface-context.tsx";
import { ChatHistoryProvider } from "@/src/contexts/ChatHistoryContext.tsx";
import { EntitlementProvider } from "@/src/contexts/entitlement-context.tsx";
import { LOCAL_FALLBACK, useNodeStore } from "@/src/store/useNodeStore.ts";
import "../../src/index.css";
const node = {
	name: "Calendar selected node",
	url: window.location.origin,
	token: "calendar-navigation-token",
	userJwt: null,
};
useNodeStore.setState({
	defaultNode: node.name,
	nodes: [LOCAL_FALLBACK, node],
	localNodes: [LOCAL_FALLBACK],
});
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const agentId =
	new URLSearchParams(window.location.search).get("agent") ?? "agent-calendar";
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={queryClient}>
		<ThemeProvider attribute="class" defaultTheme="dark">
			<MemoryRouter>
				<AppSurfaceProvider surface="desktop">
					<EntitlementProvider>
						<ChatHistoryProvider>
							<main className="h-screen bg-background p-4 text-foreground">
								<AgentCalendarView agentId={agentId} />
							</main>
						</ChatHistoryProvider>
					</EntitlementProvider>
				</AppSurfaceProvider>
			</MemoryRouter>
		</ThemeProvider>
	</QueryClientProvider>
);
