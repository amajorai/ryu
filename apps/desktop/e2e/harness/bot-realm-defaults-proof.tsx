import { I18nProvider } from "@ryu/i18n/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { BotRealmDefaultCard } from "../../src/components/gateway/BotRealmDefaultCard.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { TabsProvider } from "../../src/contexts/TabsContext.tsx";
import type { AgentSelection } from "../../src/lib/api/preferences.ts";
import { EMPTY_AGENT_SELECTION } from "../../src/lib/api/preferences.ts";
import { setInterfaceLevel } from "../../src/lib/interface-level.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

const MANAGED_NODE = {
	managed: true,
	name: "cloud-bot-proof",
	orgId: "org-proof",
	token: null,
	url: "http://bot-realm-proof.local",
	userJwt: "proof-user-jwt",
};

useNodeStore.setState({
	cloudNodes: [MANAGED_NODE],
	defaultNode: MANAGED_NODE.name,
	localNodes: [MANAGED_NODE],
	nodes: [MANAGED_NODE],
});
setInterfaceLevel("expert");

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
	const requestUrl = input instanceof Request ? input.url : String(input);
	const url = new URL(requestUrl, window.location.origin);
	const json = <FixturePayload,>(body: FixturePayload, status = 200) =>
		new Response(JSON.stringify(body), {
			headers: { "content-type": "application/json" },
			status,
		});

	if (url.pathname === "/api/auth/get-session") {
		return json({ session: null, user: null });
	}
	if (url.pathname === "/api/agents") {
		return json({
			agents: [
				{
					id: "ryu",
					name: "Ryu",
					recommended: true,
					title: "",
					transport: "openai_compat",
				},
			],
		});
	}
	if (url.pathname === "/api/engines") {
		return json({ engines: [] });
	}
	if (url.pathname === "/api/engine/active") {
		return json({ active: null, available: [], running: false });
	}
	if (url.pathname === "/api/pi-config/catalog") {
		return json({
			apiTypes: ["openai-completions"],
			providers: [
				{
					api: "openai-completions",
					authEnv: "",
					authKind: "subscription",
					configured: true,
					custom: false,
					id: "managed-openrouter",
					label: "Auto cloud",
					modelOverrides: {},
					routing: "gateway",
					suggestedModels: ["openrouter/auto", "anthropic/claude-sonnet-4"],
					supportsDiscovery: false,
				},
			],
			thinkingLevels: [],
		});
	}
	if (url.pathname.startsWith("/api/pi-config/providers/")) {
		return json({ models: [] });
	}
	if (url.pathname === "/api/preferences/default-local-agent-selection") {
		return json({
			key: "default-local-agent-selection",
			value: JSON.stringify({
				agent_id: "ryu",
				model: "gemma-4-E2B-it-Q4_K_M",
				provider: "local",
			}),
		});
	}
	if (
		url.pathname === "/api/preferences/default-cloud-agent-selection" &&
		init?.method === "PUT"
	) {
		document.body.dataset.cloudDefaultWrite = "true";
		return json({
			key: "default-cloud-agent-selection",
			ok: true,
		});
	}
	if (url.pathname === "/api/preferences/default-cloud-agent-selection") {
		return json({
			key: "default-cloud-agent-selection",
			value: null,
		});
	}
	if (url.pathname === "/api/preferences/engine.llamacpp.sleep-idle-seconds") {
		return json({
			key: "engine.llamacpp.sleep-idle-seconds",
			value: "300",
		});
	}
	if (url.pathname.startsWith("/api/")) {
		return json({});
	}

	return realFetch(input, init);
};

function selectionLabel(selection: AgentSelection): string {
	return selection.model
		? `${selection.provider} · ${selection.model}`
		: "Auto cloud";
}

function saveSelection(next: AgentSelection): void {
	void fetch(
		`${MANAGED_NODE.url}/api/preferences/default-cloud-agent-selection`,
		{
			body: JSON.stringify({ value: JSON.stringify(next) }),
			headers: { "Content-Type": "application/json" },
			method: "PUT",
		}
	);
}

function Story() {
	const [selection, setSelection] = useState<AgentSelection>(
		EMPTY_AGENT_SELECTION
	);
	const onSelectionChange = (next: AgentSelection) => {
		setSelection(next);
		saveSelection(next);
	};

	return (
		<AppSurfaceProvider surface="desktop">
			<ThemeProvider attribute="class" defaultTheme="light" enableSystem>
				<main className="min-h-screen bg-background p-8 text-foreground">
					<div className="mx-auto flex min-h-[720px] max-w-3xl flex-col gap-6 rounded-3xl border border-border/70 bg-card p-8 shadow-2xl">
						<header className="border-border/70 border-b pb-6">
							<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
								Agent · managed workspace
							</p>
							<h1 className="mt-2 font-semibold text-3xl tracking-tight">
								Bot realm defaults
							</h1>
							<p className="mt-2 max-w-2xl text-muted-foreground text-sm leading-relaxed">
								Organization owners and admins choose the provider and model
								that managed Bot chats inherit.
							</p>
						</header>

						<div className="rounded-2xl border border-primary/20 bg-primary/5 p-4">
							<p className="font-medium text-sm">Admin configuration</p>
							<p className="mt-1 text-muted-foreground text-sm">
								The field starts at Auto cloud when no custom route is saved.
								Pick a model to set the managed Bot realm default.
							</p>
						</div>

						<BotRealmDefaultCard
							canConfigure
							loaded
							managed
							onChange={onSelectionChange}
							target={MANAGED_NODE}
							value={selection}
						/>

						<output
							className="rounded-xl bg-muted/50 px-4 py-3 text-muted-foreground text-sm"
							data-testid="selected-bot-default"
						>
							Saved selection: {selectionLabel(selection)}
						</output>
					</div>
				</main>
			</ThemeProvider>
		</AppSurfaceProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<QueryClientProvider client={queryClient}>
			<I18nProvider>
				<EntitlementProvider>
					<TabsProvider>
						<MemoryRouter>
							<Story />
						</MemoryRouter>
					</TabsProvider>
				</EntitlementProvider>
			</I18nProvider>
		</QueryClientProvider>
	);
}
