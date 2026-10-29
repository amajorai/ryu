import { z } from "zod";
import { createTabsProofContext } from "./tabs-proof-context.ts";

declare const window: Window;

import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CreateAgentDialog } from "../../src/components/agents/CreateAgentDialog.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { TabsContext } from "../../src/contexts/TabsContext.tsx";
import { useAgents } from "../../src/hooks/useAgents.ts";
import { queryClient } from "../../src/lib/query-client.ts";
import {
	type ChannelSetupRequest,
	useChannelSetupDialog,
} from "../../src/store/useChannelSetupDialog.ts";
import { useCreateAgentDialog } from "../../src/store/useCreateAgentDialog.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

const STORAGE_KEY = "ryu-create-agent-dialog-proof";
const PROOF_AVATAR =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='8' fill='%230ea5e9'/%3E%3C/svg%3E";
const NODE = {
	managed: false,
	name: "create-agent-proof",
	orgId: null,
	token: "create-agent-proof-token",
	url: window.location.origin,
	userJwt: null,
};

interface RequestRecord {
	body: unknown;
	method: string;
	path: string;
}

interface PersistedAgent {
	id: string;
	input: z.infer<typeof agentInputSchema>;
}

interface StoredFixture {
	agents: PersistedAgent[];
	requests: RequestRecord[];
}

interface TabCall {
	options?: unknown;
	path: string;
}

export interface CreateAgentProofApi {
	armFailure: (operation: "create" | "stream") => void;
	armPendingCreate: () => void;
	releasePendingCreate: () => void;
	snapshot: () => {
		channel: { open: boolean; request: ChannelSetupRequest | null };
		persisted: PersistedAgent[];
		requests: RequestRecord[];
		tabs: TabCall[];
	};
}

const capturedTabs: TabCall[] = [];

declare global {
	interface Window {
		__createAgentDialogProof: CreateAgentProofApi;
	}
}

// The `POST /api/agents` wire body (`toAgentBody`), stored as sent.
const agentInputSchema = z
	.object({
		name: z.string(),
		chat_model: z
			.object({
				engine: z.string().nullable(),
				model_id: z.string().nullable(),
			})
			.nullable()
			.optional(),
		persona: z.json().optional(),
		description: z.string().nullable(),
		engine: z.string().nullable(),
		identity_mode: z.enum(["managed", "individual", "mixed"]).optional(),
		account_access: z.array(z.string()).nullable().optional(),
		system_prompt: z.string().nullable(),
		tools: z.array(z.string()),
		model: z.string().nullable().optional(),
		title: z.string().optional(),
		version: z.string().optional(),
	})
	.catchall(z.json());
const launchCheckBodySchema = z.object({
	engine: z.string(),
	identity_mode: z.enum(["managed", "individual", "mixed"]),
	account_access: z.array(z.string()).nullable(),
});
const storedFixtureSchema = z.object({
	agents: z.array(z.object({ id: z.string(), input: agentInputSchema })),
	requests: z.array(
		z.object({ body: z.json(), method: z.string(), path: z.string() })
	),
});
function readStored(): StoredFixture {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw
			? storedFixtureSchema.parse(JSON.parse(raw))
			: { agents: [], requests: [] };
	} catch {
		return { agents: [], requests: [] };
	}
}

function writeStored(state: StoredFixture): void {
	localStorage.setItem(
		STORAGE_KEY,
		JSON.stringify({ agents: state.agents, requests: [] })
	);
}

function response<FixturePayload>(
	body: FixturePayload,
	status = 200
): Response {
	return Response.json(body, { status });
}

function parseBody(init?: RequestInit) {
	if (!isNativeText(init?.body)) {
		return null;
	}
	try {
		return parseProofJson(init.body);
	} catch {
		return init.body;
	}
}

function toAgentRecord(input: z.infer<typeof agentInputSchema>, id: string) {
	return {
		account_access: input.account_access ?? null,
		built_in: false,
		chat_model: input.chat_model ?? null,
		created_at: "2026-09-28T00:00:00Z",
		description: input.description,
		engine: input.engine,
		id,
		identity_mode: input.identity_mode ?? "managed",
		lifecycle_status: "active",
		model: input.model,
		name: input.name,
		persona: input.persona ?? null,
		safety_profile: "autonomous",
		system_prompt: input.system_prompt,
		title: input.title ?? "",
		tools: input.tools,
		updated_at: "2026-09-28T00:00:00Z",
		version: input.version ?? "1.0.0",
	};
}

// Core's launch check, answered as a node with an account sandbox would: Ryu's
// own engine starts in every mode, and an agent whose model providers are
// limited runs on Ryu credits.
function toLaunchCheck(input: z.infer<typeof launchCheckBodySchema>) {
	const modelsLimited =
		input.identity_mode === "individual" || input.account_access !== null;
	return {
		code: null,
		launchable: true,
		limited_model_source: modelsLimited ? "ryu_credits" : null,
		model_warning: null,
		reason: null,
		runs_on_managed_pi: false,
		sandbox_supported: true,
		vendor_provider: null,
	};
}

function installLocalFixture(): void {
	const params = new URLSearchParams(window.location.search);
	if (params.get("reset") === "true") {
		localStorage.removeItem(STORAGE_KEY);
		params.delete("reset");
		window.history.replaceState(
			null,
			"",
			`${window.location.pathname}${params.size ? `?${params}` : ""}`
		);
	}

	let failNext: "create" | "stream" | null = null;
	let holdCreate = false;
	let releasePending: (() => void) | null = null;
	const requests: RequestRecord[] = [];
	const snapshot = () => ({
		channel: {
			open: useChannelSetupDialog.getState().open,
			request: structuredClone(useChannelSetupDialog.getState().request),
		},
		persisted: structuredClone(readStored().agents),
		requests: structuredClone(requests),
		tabs: structuredClone(capturedTabs),
	});
	window.__createAgentDialogProof = {
		armFailure: (operation) => {
			failNext = operation;
		},
		armPendingCreate: () => {
			holdCreate = true;
		},
		releasePendingCreate: () => {
			releasePending?.();
		},
		snapshot,
	};

	const builtInAgent = {
		avatar_url: PROOF_AVATAR,
		created_at: null,
		description: "The local Ryu agent.",
		engine: "pi",
		id: "ryu",
		installed: true,
		lifecycle_status: "active",
		model: null,
		name: "Ryu",
		recommended: true,
		system_prompt: null,
		title: "",
		transport: "acp",
	};
	const realFetch = window.fetch.bind(globalThis);
	const proofFetch = async (
		input: RequestInfo | URL,
		init?: RequestInit
	): Promise<Response> => {
		const url = new URL(
			input instanceof Request ? input.url : String(input),
			window.location.href
		);
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		if (!url.pathname.startsWith("/api/")) {
			return realFetch(input, init);
		}

		const body = parseBody(init);
		requests.push({ body, method, path: url.pathname });
		if (url.pathname === "/api/engines" && method === "GET") {
			return response({ engines: [{ id: "pi", installed: true, name: "Pi" }] });
		}
		if (url.pathname === "/api/engine/active" && method === "GET") {
			return response({ active: "pi", available: ["pi"], running: true });
		}
		if (url.pathname === "/api/engines/models" && method === "GET") {
			return response({
				models: { pi: [{ id: "proof-model", name: "Proof Model" }] },
			});
		}
		if (url.pathname === "/api/pi-config" && method === "GET") {
			return response({
				config: {
					configDir: "",
					model: "openai/gpt-5-mini",
					provider: "openrouter",
					routing: "direct",
					thinkingLevel: "medium",
				},
			});
		}
		if (url.pathname === "/api/pi-config/catalog" && method === "GET") {
			return response({ apiTypes: [], providers: [], thinkingLevels: [] });
		}
		if (url.pathname === "/api/agents" && method === "GET") {
			const saved = readStored().agents.map(({ id, input }) =>
				toAgentRecord(input, id)
			);
			return response({ agents: [builtInAgent, ...saved] });
		}
		if (url.pathname === "/api/agents/launch-check" && method === "POST") {
			return response(toLaunchCheck(launchCheckBodySchema.parse(body)));
		}
		if (url.pathname === "/api/agents" && method === "POST") {
			if (failNext === "create") {
				failNext = null;
				return response(
					{ error: "Local fixture rejected this create once." },
					503
				);
			}
			if (holdCreate) {
				holdCreate = false;
				await new Promise<void>((resolve) => {
					releasePending = resolve;
				});
				releasePending = null;
			}
			const input = agentInputSchema.parse(body);
			const id = `proof-agent-${readStored().agents.length + 1}`;
			const saved = readStored();
			saved.agents.push({ id, input });
			writeStored(saved);
			return response({ agent: toAgentRecord(input, id) }, 201);
		}
		if (url.pathname.startsWith("/api/preferences/") && method === "GET") {
			return response({ error: "preference_not_found" }, 404);
		}
		if (url.pathname === "/api/chat/stream" && method === "POST") {
			if (failNext === "stream") {
				failNext = null;
				return response({ error: "Local fixture stream unavailable." }, 503);
			}
			// Core's UI-message SSE framing (sidecar/adapters `ui_chunk`).
			return new Response(
				`${[
					{ type: "start" },
					{ id: "t1", type: "text-start" },
					{ delta: "Orbit", id: "t1", type: "text-delta" },
					{ id: "t1", type: "text-end" },
					{ type: "finish" },
				]
					.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
					.join("")}data: [DONE]\n\n`,
				{
					headers: {
						"Content-Type": "text/event-stream",
						"x-vercel-ai-ui-message-stream": "v1",
					},
				}
			);
		}
		if (url.pathname.endsWith("/capabilities")) {
			return response({
				capabilities: {
					model: null,
					reasoning: true,
					tools: true,
					vision: true,
				},
			});
		}
		// Remaining local Core reads used by the shared composer resolve to their
		// empty, self-hosted defaults. This fixture never calls a real provider.
		return response({});
	};
	window.fetch = proofFetch;
}

useNodeStore.setState({
	defaultNode: NODE.name,
	localNodes: [NODE],
	nodes: [NODE],
});

queryClient.clear();

function ProofAgentRoster() {
	const { agents } = useAgents();
	return (
		<article className="rounded-2xl border bg-card p-4">
			<h2 className="font-medium text-sm">Agents loaded from local Core</h2>
			<p className="mt-2 text-xs" data-testid="agent-roster-readback">
				{agents.map((agent) => agent.name).join(", ") || "Loading agents"}
			</p>
		</article>
	);
}

function ProofSurface() {
	const [tabCalls, setTabCalls] = useState<TabCall[]>([]);
	const open = useCreateAgentDialog((state) => state.open);
	const channelOpen = useChannelSetupDialog((state) => state.open);
	const channelRequest = useChannelSetupDialog((state) => state.request);
	const tabsContext = createTabsProofContext({
		openTab: <Options,>(path: string, options?: Options) => {
			const call = { path, options };
			setTabCalls((current) => [...current, call]);
			capturedTabs.push(call);
			return `proof-tab-${capturedTabs.length}`;
		},
		updateTabsIconWhere: () => undefined,
	});

	useEffect(() => {
		useCreateAgentDialog.getState().openCreateAgent();
	}, []);

	return (
		<ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
			<QueryClientProvider client={queryClient}>
				<EntitlementProvider>
					<TabsContext.Provider value={tabsContext}>
						<main className="min-h-screen bg-background p-6 text-foreground">
							<div className="mx-auto max-w-5xl">
								<header className="mb-6 rounded-2xl border bg-card p-5">
									<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
										Production CreateAgentDialog · stateful local Core fixture
									</p>
									<h1 className="mt-2 font-semibold text-2xl">
										Create an agent
									</h1>
									<p className="mt-2 text-muted-foreground text-sm">
										The production dialog talks to a local fixture that stores
										agent records between reloads. No account, provider, or
										external service is used.
									</p>
									<button
										className="mt-4 rounded-lg border px-3 py-2 text-sm"
										onClick={() =>
											useCreateAgentDialog.getState().openCreateAgent()
										}
										type="button"
									>
										Open create dialog
									</button>
								</header>
								<section className="grid gap-4 md:grid-cols-2">
									<ProofAgentRoster />
									<article className="rounded-2xl border bg-card p-4">
										<h2 className="font-medium text-sm">Navigation handoff</h2>
										<pre
											className="mt-2 overflow-auto text-xs"
											data-testid="tab-calls"
										>
											{JSON.stringify(tabCalls, null, 2)}
										</pre>
									</article>
									<article className="rounded-2xl border bg-card p-4">
										<h2 className="font-medium text-sm">
											Selected channel setup
										</h2>
										<pre
											className="mt-2 overflow-auto text-xs"
											data-testid="channel-request"
										>
											{JSON.stringify(
												{ open: channelOpen, request: channelRequest },
												null,
												2
											)}
										</pre>
									</article>
								</section>
								<p
									className="mt-4 text-muted-foreground text-xs"
									data-testid="dialog-state"
								>
									Dialog {open ? "open" : "closed"}
								</p>
							</div>
							<CreateAgentDialog />
						</main>
						<Toaster position="bottom-right" theme="light" />
					</TabsContext.Provider>
				</EntitlementProvider>
			</QueryClientProvider>
		</ThemeProvider>
	);
}

installLocalFixture();

const root = document.getElementById("root");
if (!root) {
	throw new Error("Create agent proof root not found.");
}

createRoot(root).render(<ProofSurface />);
document.body.dataset.harnessReady = "1";
