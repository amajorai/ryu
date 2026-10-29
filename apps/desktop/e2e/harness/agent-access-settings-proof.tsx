import { I18nProvider } from "@ryu/i18n/react";
import { I18nDirectionProvider } from "@ryu/ui/components/direction.tsx";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { AgentAccessPanel } from "../../src/components/settings/AgentAccessPanel.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import type { ApiTarget } from "../../src/lib/api/client.ts";
import "../../src/index.css";

const AGENT_ID = "agent-access-demo";
const TARGET: ApiTarget = {
	token: null,
	url: window.location.origin,
	userJwt: null,
};
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

function ProofSurface() {
	return (
		<AppSurfaceProvider surface="desktop">
			<I18nProvider>
				<I18nDirectionProvider>
					<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
						<main className="min-h-dvh bg-background p-8 text-foreground">
							<div className="mx-auto flex max-w-4xl flex-col gap-6">
								<header className="rounded-2xl border bg-card p-6 shadow-sm">
									<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
										Production component proof
									</p>
									<h1 className="mt-2 font-semibold text-2xl">Agent access</h1>
									<p className="mt-2 text-muted-foreground text-sm">
										The production AgentAccessPanel uses the Desktop agent,
										Spaces, and MCP API clients against a stateful local Core
										fixture.
									</p>
								</header>
								<AgentAccessPanel agentId={AGENT_ID} target={TARGET} />
							</div>
							<Toaster position="bottom-right" theme="dark" />
						</main>
					</ThemeProvider>
				</I18nDirectionProvider>
			</I18nProvider>
		</AppSurfaceProvider>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Agent access proof root not found.");
}

createRoot(root).render(
	<QueryClientProvider client={queryClient}>
		<MemoryRouter>
			<ProofSurface />
		</MemoryRouter>
	</QueryClientProvider>
);
document.body.dataset.harnessReady = "1";
