import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { TabsContext } from "../../src/contexts/TabsContext.tsx";
import { TitleBarProvider } from "../../src/contexts/TitleBarContext.tsx";
import type { AgentRulesConfig } from "../../src/lib/api/agent-rules.ts";
import { queryClient as appQueryClient } from "../../src/lib/query-client.ts";
import AgentEditPage from "../../src/pages/AgentEditPage.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { useWorkspaceStore } from "../../src/store/useWorkspaceStore.ts";
import { type ProofJsonValue, parseProofJson } from "../fixture-json.ts";
import { createTabsProofContext } from "./tabs-proof-context.ts";
import "../../src/index.css";

const AGENT_ID = "rules-panel-proof-agent";
const PREFERENCE_KEY = `rules.agent.${encodeURIComponent(AGENT_ID)}`;
const PROJECT_CWD = "/workspace/rules-panel-proof";
const STORAGE_KEY = "ryu:e2e:rules-agent-edit-panel";
const shippedProfileFiles = import.meta.glob<string>(
	"../../../../plugins-store/plugins/output-styles/output-styles/*.md",
	{ eager: true, query: "?raw", import: "default" }
);
const shippedProfiles = Object.entries(shippedProfileFiles).map(
	([file, body]) => {
		const frontmatter = /^---\s*\n([\s\S]*?)\n---/.exec(body)?.[1];
		if (!frontmatter) {
			throw new Error(`Missing profile metadata: ${file}`);
		}
		const fields = z
			.object({
				name: z.string(),
				description: z.string().optional(),
				"keep-coding-instructions": z.boolean().optional(),
			})
			.parse(parseYaml(frontmatter));
		return {
			id: file.split("/").at(-1)?.replace(/\.md$/, ""),
			name: fields.name,
			description: fields.description ?? "",
			source: "plugin",
			active: false,
			forced: false,
			keep_coding_instructions: fields["keep-coding-instructions"] === true,
		};
	}
);
const INITIAL_CONFIG: AgentRulesConfig = {
	applyMode: "auto",
	autoInject: true,
	enabled: true,
	rules: [
		{
			enabled: true,
			id: "existing-team-rule",
			mode: "auto",
			text: "Use the team's established conventions.",
		},
	],
	turnsPerPlan: 3,
};

interface RecordedRequest {
	body: unknown;
	method: string;
	path: string;
	status: number;
}

interface PersistedCoreState {
	outputStyleId?: string | null;
	preferences: Record<string, string>;
	requests: RecordedRequest[];
}

const PersistedStateSchema = z.object({
	outputStyleId: z.string().nullable().optional(),
	preferences: z.record(z.string(), z.string()),
	requests: z.array(
		z.object({
			body: z.json(),
			method: z.string(),
			path: z.string(),
			status: z.number(),
		})
	),
}) satisfies z.ZodType<PersistedCoreState>;
const AgentWriteSchema = z
	.object({
		persona: z
			.object({ output_style_id: z.string().nullable().optional() })
			.catchall(z.json())
			.optional(),
		name: z.string().optional(),
	})
	.catchall(z.json());
const PreferenceWriteSchema = z.object({ value: z.string() });

interface RulesAgentEditProof {
	armNextPreferenceWriteFailure: () => void;
	snapshot: () => PersistedCoreState;
}

declare global {
	interface Window {
		__outputStylesAgentProof?: { failNextAgentWrite: () => void };
		__rulesAgentEditPanelProof?: RulesAgentEditProof;
	}
}

const queryClient = new QueryClient({
	defaultOptions: {
		queries: { retry: false, staleTime: 0, refetchOnWindowFocus: false },
		mutations: { retry: false },
	},
});

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function readPersistedState(): PersistedCoreState {
	const stored = localStorage.getItem(STORAGE_KEY);
	if (!stored) {
		return { preferences: {}, requests: [] };
	}
	try {
		return PersistedStateSchema.parse(JSON.parse(stored));
	} catch {
		// Corrupt fixture state is treated as an empty Core store.
	}
	return { preferences: {}, requests: [] };
}

function writePersistedState(state: PersistedCoreState): void {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function installCoreFixture(): void {
	const params = new URLSearchParams(window.location.search);
	if (params.has("reset") || localStorage.getItem(STORAGE_KEY) === null) {
		writePersistedState({
			preferences: { [PREFERENCE_KEY]: JSON.stringify(INITIAL_CONFIG) },
			requests: [],
		});
	}
	if (params.has("reset")) {
		params.delete("reset");
		window.history.replaceState(
			null,
			"",
			`${window.location.pathname}${params.size ? `?${params}` : ""}`
		);
	}

	const locked = params.get("locked") === "true";
	const stylesMode = params.get("profiles") === "true";
	let failNextAgentWrite = false;
	window.__outputStylesAgentProof = {
		failNextAgentWrite: () => {
			failNextAgentWrite = true;
		},
	};
	let failNextPreferenceWrite = false;
	window.__rulesAgentEditPanelProof = {
		armNextPreferenceWriteFailure: () => {
			failNextPreferenceWrite = true;
		},
		snapshot: () => structuredClone(readPersistedState()),
	};
	const proofTauriWindow = window;
	const proofTauriKernel = {
		invoke: async () => undefined,
		transformCallback: () => 1,
	};
	// SAFETY: This browser fixture installs this exact complete private two-method kernel.
	// The mutation view owns only that fixture slot, not a public Tauri result contract.
	(
		proofTauriWindow as Omit<typeof proofTauriWindow, "__TAURI_INTERNALS__"> & {
			__TAURI_INTERNALS__: typeof proofTauriKernel;
		}
	).__TAURI_INTERNALS__ = proofTauriKernel;

	const node = {
		managed: false,
		name: "local",
		orgId: null,
		token: null,
		url: window.location.origin,
		userJwt: null,
	};
	useNodeStore.setState({
		defaultNode: node.name,
		localNodes: [node],
		nodes: [node],
	});
	useWorkspaceStore.setState({ folder: PROJECT_CWD });
	appQueryClient.clear();
	queryClient.clear();
	const localAssetFetch = window.fetch.bind(window);

	Object.defineProperty(window, "fetch", {
		configurable: true,
		value: async (input: RequestInfo | URL, init?: RequestInit) => {
			const rawUrl = input instanceof Request ? input.url : String(input);
			const url = new URL(rawUrl, window.location.href);
			if (
				stylesMode &&
				url.origin === window.location.origin &&
				!url.pathname.startsWith("/api/")
			) {
				return localAssetFetch(input, init);
			}
			const method = (
				init?.method ?? (input instanceof Request ? input.method : "GET")
			).toUpperCase();
			let body: ProofJsonValue = null;
			if (isNativeText(init?.body)) {
				try {
					body = parseProofJson(init.body);
				} catch {
					body = init.body;
				}
			}
			const state = readPersistedState();
			let status = 200;
			let response: Response;
			const request: RecordedRequest = {
				body,
				method,
				path: url.pathname,
				status,
			};
			state.requests.push(request);

			if (url.pathname === "/api/plugins/contributions" && method === "GET") {
				response = json({
					agent_edit_panels: [
						{
							id: "rules",
							plugin: "@ryu/rules",
							pref_key_prefix: "rules.agent.",
							title: "Rules",
							type: "rules",
						},
					],
				});
			} else if (url.pathname === "/api/agents" && method === "GET") {
				response = json({
					agents: [
						...(stylesMode
							? [
									{
										id: "codex",
										name: "Codex",
										built_in: true,
										engine: "codex",
										installed: true,
										transport: "acp",
										lifecycle_status: "active",
										locked: false,
										safety_profile: "read_only",
									},
								]
							: []),
						{
							built_in: true,
							engine: "codex",
							id: AGENT_ID,
							installed: true,
							lifecycle_status: "active",
							locked,
							name: "Rules panel proof agent",
							recommended: false,
							safety_profile: "read_only",
							transport: "acp",
						},
					],
				});
			} else if (
				url.pathname === `/api/agents/${AGENT_ID}` &&
				method === "GET"
			) {
				await new Promise((resolve) => window.setTimeout(resolve, 180));
				response = json({
					agent: {
						built_in: true,
						chat_model: { engine: null, model_id: null },
						engine: stylesMode ? "codex" : undefined,
						composio_actions: [],
						id: AGENT_ID,
						lifecycle_status: "active",
						locked,
						memory: { read_levels: [], space_ids: [], write_enabled: false },
						name: "Rules panel proof agent",
						orchestrator: true,
						persona: stylesMode
							? { output_style_id: state.outputStyleId ?? null }
							: null,
						safety_profile: "read_only",
						skills: [],
						system_prompt: "Follow the saved agent instructions.",
						title: "",
						tools: [],
						version: "1.0.0",
					},
				});
			} else if (
				stylesMode &&
				url.pathname === `/api/agents/${AGENT_ID}` &&
				method === "PUT"
			) {
				if (failNextAgentWrite) {
					failNextAgentWrite = false;
					status = 503;
					response = json(
						{ message: "Profile save unavailable. Try again." },
						status
					);
				} else {
					const saved = AgentWriteSchema.parse(body);
					state.outputStyleId = saved.persona?.output_style_id ?? null;
					response = json({
						agent: {
							...saved,
							id: AGENT_ID,
							built_in: true,
							lifecycle_status: "active",
							locked: false,
							installed: true,
						},
					});
				}
			} else if (
				url.pathname === `/api/agents/${AGENT_ID}/tools` &&
				method === "GET"
			) {
				response = json({ mcpTools: [], tools: [] });
			} else if (url.pathname === "/api/engines" && method === "GET") {
				response = json({
					engines: [{ id: "codex", installed: true, name: "Codex" }],
				});
			} else if (url.pathname === "/api/engine/active" && method === "GET") {
				response = json({
					active: "codex",
					available: ["codex"],
					running: true,
				});
			} else if (url.pathname === "/api/output-styles" && method === "GET") {
				response = json({
					forced: null,
					selected: null,
					styles: stylesMode ? shippedProfiles : [],
				});
			} else if (url.pathname === "/api/rules/discover" && method === "GET") {
				response = json({
					cwd: PROJECT_CWD,
					rules: [
						{
							apply_mode: "always",
							content: "Keep project changes focused.",
							name: "architecture.mdc",
							path: ".cursor/rules/architecture.mdc",
							provider: "cursor",
						},
					],
				});
			} else if (
				url.pathname.startsWith("/api/preferences/") &&
				method === "GET"
			) {
				const key = decodeURIComponent(
					url.pathname.slice("/api/preferences/".length)
				);
				const value = state.preferences[key];
				if (isNativeText(value)) {
					response = json({ key, value });
				} else {
					status = 404;
					response = json({ message: "Preference not found" }, status);
				}
			} else if (
				url.pathname.startsWith("/api/preferences/") &&
				method === "PUT"
			) {
				const key = decodeURIComponent(
					url.pathname.slice("/api/preferences/".length)
				);
				if (failNextPreferenceWrite) {
					failNextPreferenceWrite = false;
					status = 503;
					response = json(
						{ message: "Local Core fixture rejected the write." },
						status
					);
				} else if (PreferenceWriteSchema.safeParse(body).success) {
					state.preferences[key] = PreferenceWriteSchema.parse(body).value;
					response = json({ key, ok: true });
				} else {
					status = 400;
					response = json(
						{ message: "Expected a string preference value." },
						status
					);
				}
			} else if (url.pathname === "/api/mcp/tools" && method === "GET") {
				response = json({ tools: [] });
			} else if (url.pathname === "/api/skills" && method === "GET") {
				response = json({ skills: [] });
			} else if (url.pathname === "/api/spaces" && method === "GET") {
				response = json({ spaces: [] });
			} else {
				response = json({});
			}

			request.status = status;
			writePersistedState(state);
			return response;
		},
	});
}

function RulesAgentEditPanelProof() {
	const tabsValue = createTabsProofContext({
		activeTabId: "rules-agent-edit-proof",
		openTab: () => "rules-agent-edit-proof",
		updateTabTitle: () => undefined,
	});

	return (
		<AppSurfaceProvider surface="desktop">
			<EntitlementProvider>
				<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
					<TitleBarProvider>
						<TabsContext.Provider value={tabsValue}>
							<main className="min-h-screen bg-background px-6 py-8 text-foreground sm:px-10">
								<div className="mx-auto max-w-5xl">
									<header className="mb-6">
										<p className="text-muted-foreground text-xs uppercase tracking-wide">
											Production AgentEditPage route
										</p>
										<h1 className="mt-2 font-semibold text-3xl tracking-tight">
											Agent settings
										</h1>
									</header>
									<Routes>
										<Route
											element={<AgentEditPage />}
											path="/agents/:agentId/edit"
										/>
										<Route
											element={
												<div data-testid="agent-list-returned">Agents</div>
											}
											path="/library/agent"
										/>
									</Routes>
								</div>
								<Toaster position="bottom-right" theme="dark" />
							</main>
						</TabsContext.Provider>
					</TitleBarProvider>
				</ThemeProvider>
			</EntitlementProvider>
		</AppSurfaceProvider>
	);
}

installCoreFixture();

const root = document.getElementById("root");
if (!root) {
	throw new Error("Rules agent edit panel proof root not found");
}

createRoot(root).render(
	<QueryClientProvider client={queryClient}>
		<I18nProvider>
			<MemoryRouter initialEntries={[`/agents/${AGENT_ID}/edit`]}>
				<RulesAgentEditPanelProof />
			</MemoryRouter>
		</I18nProvider>
	</QueryClientProvider>
);
document.body.dataset.harnessReady = "1";
