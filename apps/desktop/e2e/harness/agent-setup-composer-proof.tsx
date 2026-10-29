declare const window: Window;

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { AgentSetupComposer } from "../../src/components/agents/AgentSetupComposer.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import type { AgentSummary } from "../../src/lib/api/agents.ts";
import styles from "./agent-setup-composer-proof.module.css";
import "../../src/index.css";

const requestInputStringSchema = z.string();
const PROOF_AVATAR =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='8' fill='%230ea5e9'/%3E%3C/svg%3E";

const agents: AgentSummary[] = [
	{
		avatarUrl: PROOF_AVATAR,
		avatarGlyph: null,
		lifecycleStatus: "active",
		safetyProfile: "autonomous",
		builtIn: true,
		createdAt: null,
		description: "The general-purpose Ryu agent.",
		engine: "pi",
		id: "ryu",
		installed: true,
		installHint: null,
		latestVersion: null,
		locked: false,
		model: null,
		name: "Ryu",
		recommended: true,
		systemPrompt: null,
		title: "",
		transport: "acp",
		version: null,
		versionStatus: null,
	},
	{
		avatarUrl: PROOF_AVATAR,
		avatarGlyph: null,
		lifecycleStatus: "active",
		safetyProfile: "autonomous",
		builtIn: true,
		createdAt: null,
		description: "A focused coding agent.",
		engine: "claude",
		id: "claude",
		installed: true,
		installHint: null,
		latestVersion: null,
		locked: false,
		model: null,
		name: "Claude Code",
		recommended: false,
		systemPrompt: null,
		title: "",
		transport: "acp",
		version: null,
		versionStatus: null,
	},
];

const json = <FixturePayload,>(body: FixturePayload) =>
	new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status: 200,
	});

function installProofNetwork() {
	const nativeFetch = window.fetch.bind(window);
	window.fetch = async (input, init) => {
		const inputString = requestInputStringSchema.safeParse(input);
		const url = inputString.success
			? inputString.data
			: input instanceof Request
				? input.url
				: input.toString();

		if (url.endsWith("/api/engines/models")) {
			return json({
				models: {
					claude: [
						{ id: "sonnet", name: "Sonnet" },
						{ id: "opus", name: "Opus" },
					],
					pi: [{ id: "default", name: "Default" }],
				},
			});
		}
		if (url.endsWith("/api/models/installed")) {
			return json({ models: [] });
		}
		if (url.endsWith("/api/models/active")) {
			return json({
				active: "",
				default: "",
				engine: null,
				format: "gguf",
				ref: null,
				repo_id: null,
			});
		}
		if (
			url.endsWith("/api/preferences/entitlement-active") ||
			url.endsWith("/api/preferences/managed-inference-entitled")
		) {
			return json({ key: url.split("/api/preferences/")[1], value: "false" });
		}
		if (url.endsWith("/api/pi-config")) {
			return json({
				config: {
					configDir: "",
					model: "openai/gpt-5-mini",
					provider: "openrouter",
					routing: "direct",
					thinkingLevel: "medium",
				},
			});
		}
		if (url.endsWith("/api/pi-config/catalog")) {
			return json({
				apiTypes: ["openai-completions"],
				providers: [
					{
						api: "openai-completions",
						authEnv: "OPENROUTER_API_KEY",
						authKind: "api-key",
						configured: true,
						custom: false,
						id: "openrouter",
						label: "OpenRouter",
						managed: false,
						routing: "direct",
						suggestedModels: ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"],
						supportsDiscovery: false,
					},
					{
						api: "anthropic-messages",
						authEnv: "ANTHROPIC_API_KEY",
						authKind: "api-key",
						configured: true,
						custom: false,
						id: "anthropic",
						label: "Anthropic",
						managed: false,
						routing: "direct",
						suggestedModels: ["claude-sonnet-4", "claude-opus-4"],
						supportsDiscovery: false,
					},
				],
				thinkingLevels: ["low", "medium", "high"],
			});
		}
		if (url.includes("/api/providers/") && url.endsWith("/credits")) {
			return json({
				available: false,
				meters: [],
				provider_id: "openrouter",
				reason: null,
				retry_after_seconds: null,
			});
		}
		if (url.includes("/api/agents/catalog")) {
			return json({ agents: [] });
		}
		if (url.includes("/api/agents/") && url.includes("/capabilities")) {
			return json({
				capabilities: {
					model: null,
					reasoning: true,
					tools: true,
					vision: true,
				},
			});
		}
		if (url.includes("/api/agents/") && url.endsWith("/usage")) {
			return json({
				agent_id: "claude",
				available: false,
				engine: "claude",
				meters: [],
				reason: "unsupported",
				windows: [],
			});
		}
		if (url.includes("/api/agents/") && url.endsWith("/accounts")) {
			return json({ accounts: [] });
		}
		if (url.includes("/api/agents/") && url.includes("/acp-config")) {
			return json({ configOptions: null, models: null, modes: null });
		}
		if (url.endsWith("/api/output-styles")) {
			return json({ styles: [], selected: null, forced: null });
		}
		if (url.includes("/api/routing/advice")) {
			return json({});
		}

		return nativeFetch(input, init);
	};
}

function AgentSetupComposerProof() {
	const [engine, setEngine] = useState("acp:pi");
	const [instructions, setInstructions] = useState(
		"# Build a careful coding agent\n\n- Explain the plan before editing.\n- Keep changes focused."
	);
	const [model, setModel] = useState("default");
	const [modelEngine, setModelEngine] = useState<string | null>(null);

	return (
		<main className="min-h-screen bg-background px-6 py-10 text-foreground">
			<div className="mx-auto max-w-4xl">
				<header className="mb-8">
					<p
						className={`font-medium text-muted-foreground text-xs uppercase ${styles.eyebrow}`}
					>
						Production component proof
					</p>
					<h1 className="mt-2 font-semibold text-4xl tracking-tight">
						Agent setup composer
					</h1>
					<p className="mt-3 max-w-2xl text-muted-foreground">
						Create and edit use one familiar surface: write the agent
						instructions, then choose the runtime, provider, and model from the
						bottom bar.
					</p>
				</header>

				<section className="rounded-3xl border bg-card p-5 shadow-sm">
					<div className="mb-4 flex items-center justify-between gap-4">
						<div>
							<h2 className="font-semibold text-lg">Instructions & model</h2>
							<p className="mt-1 text-muted-foreground text-sm">
								The compact composer keeps setup to one glanceable control row.
							</p>
						</div>
						<span
							className="rounded-full bg-primary/10 px-3 py-1 font-medium text-primary text-xs"
							data-testid="selection-summary"
						>
							{engine} · {modelEngine ?? "Ryu"} · {model}
						</span>
					</div>
					<AgentSetupComposer
						agents={agents}
						engine={engine}
						instructions={instructions}
						model={model}
						modelEngine={modelEngine}
						onEngineChange={setEngine}
						onInstructionsChange={setInstructions}
						onModelChange={setModel}
						onModelEngineChange={setModelEngine}
					/>
				</section>

				<pre
					className="mt-5 overflow-auto rounded-2xl border bg-muted/40 p-4 text-muted-foreground text-xs"
					data-testid="saved-state"
				>
					{JSON.stringify(
						{ engine, instructions, model, modelEngine },
						null,
						2
					)}
				</pre>
			</div>
		</main>
	);
}

installProofNetwork();

const queryClient = new QueryClient({
	defaultOptions: {
		queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
	},
});

createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={queryClient}>
		<EntitlementProvider>
			<AgentSetupComposerProof />
		</EntitlementProvider>
	</QueryClientProvider>
);
