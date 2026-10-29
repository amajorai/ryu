declare const window: Window;

import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { AgentModelsSettings } from "../../src/components/settings/AgentModelsSettings.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import type { ApiTarget } from "../../src/lib/api/client.ts";
import { setModelEnabled } from "../../src/lib/api/pi-config.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import {
	type AgentModelsJson,
	type AgentModelsProofState,
	type AgentModelsRequest,
	type AgentModelsSnapshot,
	agentModelsBodyStringSchema,
	agentModelsEnabledSchema,
	agentModelsSnapshotSchema,
} from "../agent-models-proof.contracts.ts";
import { parseProofJson } from "../fixture-json.ts";
import styles from "./agent-models-settings-proof.module.css";
import "../../src/index.css";

const NODE = {
	managed: false,
	name: "agent-models-settings-proof",
	orgId: null,
	token: null,
	url: "http://127.0.0.1:7984",
	userJwt: null,
};
const STORAGE_KEY = "ryu-agent-models-settings-proof";

const AGENTS = [
	{ id: "ryu", name: "Ryu", transport: "openai_compat" },
	{ id: "codex", name: "Codex", transport: "acp" },
	{ id: "opencode", name: "OpenCode", transport: "acp" },
	{ id: "self-selecting", name: "Self Selecting Agent", transport: "acp" },
];

function freshState(): AgentModelsSnapshot {
	return { agentModelOverrides: {}, requests: [] };
}

function readPersisted(): AgentModelsSnapshot {
	const stored = localStorage.getItem(STORAGE_KEY);
	if (!stored) {
		const initial = freshState();
		localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
		return initial;
	}
	return agentModelsSnapshotSchema.parse(JSON.parse(stored));
}

function persist(next: AgentModelsSnapshot): void {
	localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...next, requests: [] }));
}

function response<FixturePayload>(
	body: FixturePayload,
	status = 200
): Response {
	return Response.json(body, { status });
}

function requestedBody(init?: RequestInit): AgentModelsJson {
	const rawBody = init?.body;
	const bodyString = agentModelsBodyStringSchema.safeParse(rawBody);
	if (!bodyString.success) {
		return null;
	}
	try {
		return parseProofJson(bodyString.data);
	} catch {
		return bodyString.data;
	}
}

function installFixture(): AgentModelsProofState {
	const params = new URLSearchParams(window.location.search);
	if (params.get("reset") === "true") {
		localStorage.removeItem(STORAGE_KEY);
		params.delete("reset");
		const query = params.toString();
		window.history.replaceState(
			null,
			"",
			`${window.location.pathname}${query ? `?${query}` : ""}`
		);
	}
	let holdNextWrite = false;
	let nextFailure = params.get("failAgentsOnce") === "true" ? "agents" : "";
	let releasePendingWrite: () => void = () => undefined;
	const requests: AgentModelsRequest[] = [];
	const proof: AgentModelsProofState = {
		armFailure: (operation) => {
			if (operation === "hold-write") {
				holdNextWrite = true;
				return;
			}
			nextFailure = operation;
		},
		releasePendingWrite: () => releasePendingWrite(),
		refreshAgents: async () => undefined,
		requests,
		snapshot: () => structuredClone({ ...readPersisted(), requests }),
	};
	window.__agentModelsSettingsProof = proof;
	const realFetch = window.fetch.bind(window);
	window.fetch = async (input, init) => {
		const url = new URL(
			input instanceof Request ? input.url : String(input),
			window.location.href
		);
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		if (
			url.pathname.startsWith("/api/agents") ||
			url.pathname.endsWith("/api/pi-config/providers/model-enabled")
		) {
			const record: AgentModelsRequest = {
				body: requestedBody(init),
				method,
				path: url.pathname + url.search,
			};
			requests.push(record);
			if (nextFailure === "agents" && url.pathname === "/api/agents") {
				nextFailure = "";
				return response({ error: "agent_service_unavailable" }, 503);
			}
			if (
				nextFailure === "codex-config" &&
				url.pathname === "/api/agents/codex/acp-config"
			) {
				nextFailure = "";
				return response({ error: "agent_probe_failed" }, 503);
			}
			if (
				nextFailure === "permission" &&
				url.pathname === "/api/pi-config/providers/model-enabled"
			) {
				nextFailure = "";
				return response({ error: "permission_denied" }, 403);
			}
			if (url.pathname === "/api/agents" && method === "GET") {
				return response({
					agents: params.get("empty") === "true" ? [] : AGENTS,
				});
			}
			if (url.pathname === "/api/agents/codex/acp-config" && method === "GET") {
				return response({
					configOptions: [],
					models: {
						availableModels: [
							{ modelId: "codex-pro", name: "Codex Pro" },
							{ modelId: "codex-fast", name: "Codex Fast" },
						],
						currentModelId: "codex-pro",
					},
					modes: null,
				});
			}
			if (
				url.pathname === "/api/agents/opencode/acp-config" &&
				method === "GET"
			) {
				return response({
					configOptions: [
						{
							category: "model",
							id: "model",
							name: "Model",
							options: [
								{ name: "OpenCode Balanced", value: "opencode-balanced" },
								{ name: "OpenCode Fast", value: "opencode-fast" },
							],
							type: "select",
						},
					],
					models: null,
					modes: null,
				});
			}
			if (
				url.pathname === "/api/agents/self-selecting/acp-config" &&
				method === "GET"
			) {
				return response({ configOptions: [], models: null, modes: null });
			}
			if (
				url.pathname === "/api/pi-config/providers/model-enabled" &&
				method === "POST"
			) {
				if (holdNextWrite) {
					holdNextWrite = false;
					await new Promise<void>((resolve) => {
						releasePendingWrite = resolve;
					});
				}
				const body = agentModelsEnabledSchema.parse(record.body);
				const agentId = body.provider.replace(/^agent:/u, "");
				const stored = readPersisted();
				stored.agentModelOverrides[agentId] = {
					...stored.agentModelOverrides[agentId],
					[body.model]: body.enabled,
				};
				persist(stored);
				return response({ agentModelOverrides: stored.agentModelOverrides });
			}
			return response({ error: "fixture_route_not_found" }, 404);
		}
		return realFetch(input, init);
	};
	useNodeStore.setState({
		activeNodeOnline: true,
		cloudNodes: [],
		defaultNode: NODE.name,
		localNodes: [NODE],
		nodes: [NODE],
	});
	return proof;
}

const installedProof = installFixture();

const target: ApiTarget = { token: null, url: NODE.url, userJwt: null };
const queryClient = new QueryClient({
	defaultOptions: {
		queries: { refetchOnWindowFocus: false, retry: false },
	},
});
installedProof.refreshAgents = async () => {
	await queryClient.invalidateQueries({ queryKey: ["agents", NODE.url] });
};

function ProofSurface() {
	const [agentModelOverrides, setAgentModelOverrides] = useState(
		() => readPersisted().agentModelOverrides
	);
	const onToggleModel = async (
		provider: string,
		model: string,
		enabled: boolean
	) => {
		const catalog = await setModelEnabled(target, { provider, model, enabled });
		setAgentModelOverrides(catalog.agentModelOverrides ?? {});
	};
	return (
		<AppSurfaceProvider surface="desktop">
			<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
				<main className="mx-auto min-h-screen max-w-3xl bg-background px-8 py-10 text-foreground">
					<header className="mb-7">
						<p
							className={`font-medium text-muted-foreground text-xs uppercase ${styles.eyebrow}`}
						>
							Production component proof
						</p>
						<h1 className="mt-2 font-semibold text-3xl tracking-tight">
							Agent model visibility
						</h1>
						<p className="mt-3 text-muted-foreground text-sm">
							Rendered AgentModelsSettings using stateful local agents, ACP
							capability, and Core model-visibility fixtures.
						</p>
					</header>
					<AgentModelsSettings
						agentModelOverrides={agentModelOverrides}
						onToggleModel={onToggleModel}
					/>
					<Toaster position="bottom-right" theme="system" />
				</main>
			</ThemeProvider>
		</AppSurfaceProvider>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Agent models proof root not found");
}

createRoot(root).render(
	<QueryClientProvider client={queryClient}>
		<I18nProvider>
			<MemoryRouter>
				<ProofSurface />
			</MemoryRouter>
		</I18nProvider>
	</QueryClientProvider>
);
document.body.dataset.harnessReady = "1";
