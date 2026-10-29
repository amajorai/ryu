// Local endpoint fixture; real permanent AppWidget and ChatPage host rendering.

import { useModelContextStore } from "@ryu/app-host/model-context";
import type { OpenedFileAccess } from "@ryu/app-host/opened-file";
import { AgentAvailabilityProvider } from "@ryu/blocks/desktop/agent-availability.tsx";
import { HotkeysProvider } from "@ryu/hotkeys/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { SidebarProvider } from "@ryu/ui/components/sidebar.tsx";
import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider, useTheme } from "next-themes";
import { createRoot } from "react-dom/client";
import { AssistantPanel } from "../../src/components/assistant/AssistantPanel.tsx";
import { ChatDisplayPrefs } from "../../src/components/chat/ChatDisplayPrefsProvider.tsx";
import { SkillDistributionProvider } from "../../src/components/skills/SkillDistributionProvider.tsx";
import { ChatHistoryProvider } from "../../src/contexts/ChatHistoryContext.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { SpacesProvider } from "../../src/contexts/SpacesContext.tsx";
import { SystemStatusProvider } from "../../src/contexts/SystemStatusContext.tsx";
import { TabsProvider } from "../../src/contexts/TabsContext.tsx";
import { McpAppPanel } from "../../src/contributions/host/McpAppPanel.tsx";
import { DESKTOP_HOTKEYS } from "../../src/lib/hotkeys/actions.ts";
import { useAssistantStore } from "../../src/store/useAssistantStore.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

useNodeStore.setState({
	nodes: [
		{
			name: "Local verification",
			url: window.location.origin,
			token: "actor-one",
		},
	],
	defaultNode: "Local verification",
});
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const isFilePanel = new URLSearchParams(window.location.search).has("file");
const isAssistantPanel = new URLSearchParams(window.location.search).has(
	"assistant"
);
if (isAssistantPanel) {
	useModelContextStore.getState().update("assistant", "local-context", {
		content: [
			{ type: "text", text: "Selected M6 bolt" },
			{
				type: "text",
				text: "Assistant-only torque limit",
				annotations: { audience: ["assistant"] },
			},
			{
				type: "image",
				mimeType: "image/png",
				data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCioAAAAASUVORK5CYII=",
				annotations: { audience: ["assistant"] },
			},
		],
		structuredContent: { part: "bolt" },
	});
	useAssistantStore.getState().open("sidebar");
}
const selectedFile: OpenedFileAccess = {
	editable: false,
	name: "selected-parts.txt",
	uri: "file:///local-verification/selected-parts.txt",
	read: async () => ({
		uri: "file:///local-verification/selected-parts.txt",
		revision: "fixture",
		text: "Selected M6 bolt",
	}),
};
function ThemeButton() {
	const { theme, setTheme } = useTheme();
	return (
		<Button
			onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
			size="sm"
			variant="outline"
		>
			Switch theme
		</Button>
	);
}
const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing proof root");
}
createRoot(root).render(
	<ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
		<QueryClientProvider client={queryClient}>
			<AgentAvailabilityProvider status="online">
				<ChatDisplayPrefs>
					<SidebarProvider>
						<HotkeysProvider registry={DESKTOP_HOTKEYS}>
							<TooltipProvider>
								<EntitlementProvider>
									<TabsProvider
										initialTab={{ path: "/plugin/proof", title: "Parts app" }}
									>
										<SkillDistributionProvider>
											<SystemStatusProvider>
												<ChatHistoryProvider>
													<SpacesProvider>
														<main className="flex h-screen w-full flex-col bg-background text-foreground">
															<header className="flex flex-wrap items-center gap-3 border-b px-4 py-2">
																<span className="text-muted-foreground text-xs">
																	Local verification fixture · production app
																	and conversation
																</span>
																<ThemeButton />
																{isAssistantPanel ? (
																	<Button
																		onClick={() =>
																			useAssistantStore
																				.getState()
																				.dismissContext()
																		}
																		size="sm"
																		variant="outline"
																	>
																		Dismiss legacy page context
																	</Button>
																) : null}
																<Button
																	onClick={() =>
																		useNodeStore.setState({
																			nodes: [
																				{
																					name: "Local verification",
																					url: window.location.origin,
																					token: "actor-two",
																				},
																			],
																		})
																	}
																	size="sm"
																	variant="outline"
																>
																	Switch actor
																</Button>
															</header>
															<div className="min-h-0 flex-1">
																{isAssistantPanel ? (
																	<AssistantPanel bare />
																) : (
																	<McpAppPanel
																		companion={{
																			id: "proof",
																			name: "Parts app",
																			pluginId: "@local/parts",
																			label: "Parts app",
																			mcpToolId: "parts.open",
																			hasUi: true,
																			approvedGrants: [],
																			defaultCspEnforced: true,
																		}}
																		fileAccess={
																			isFilePanel ? selectedFile : undefined
																		}
																		globalEntry={!isFilePanel}
																	/>
																)}
															</div>
														</main>
													</SpacesProvider>
												</ChatHistoryProvider>
											</SystemStatusProvider>
										</SkillDistributionProvider>
									</TabsProvider>
								</EntitlementProvider>
							</TooltipProvider>
						</HotkeysProvider>
					</SidebarProvider>
				</ChatDisplayPrefs>
			</AgentAvailabilityProvider>
		</QueryClientProvider>
	</ThemeProvider>
);
