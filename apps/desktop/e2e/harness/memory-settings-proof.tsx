import { z } from "zod";

declare const window: Window;

import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { GatewayDialog } from "../../src/components/gateway/GatewayDialog.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import type { MemoryCategory, MemoryScope } from "../../src/lib/api/memory.ts";
import type { PiCatalog } from "../../src/lib/api/pi-config.ts";
import { setInterfaceLevel } from "../../src/lib/interface-level.ts";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import { useGatewayDialog } from "../../src/store/useGatewayDialog.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

// Gateway opens only in Console; grant the access App's ProductModeAccessSync
// would grant a local node.
useProductModeStore.setState({ requestedMode: "console", consoleAccess: true });

const API_BASE = "http://127.0.0.1:7973";
const PREFERENCES_KEY = "memory-settings-proof-preferences";
const MEMORY_SETTINGS_KEY = "memory-settings-proof-consent";
const MEMORY_ROWS_KEY = "memory-settings-proof-rows";
const LONG_TERM_KEY = "ryu_long_term_memory";
const NODE = {
	managed: false,
	name: "memory-settings-proof",
	orgId: null,
	token: "memory-settings-proof-token",
	url: API_BASE,
	userJwt: null,
};

interface MemoryFixtureRow {
	author_agent_id: string | null;
	category: MemoryCategory;
	content: string;
	created_at: number;
	id: string;
	importance: number;
	scope: MemoryScope;
	scope_id: string | null;
	sensitive_topics: string[];
	tags: string[];
	updated_at: number;
	when_to_use: string | null;
}

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
	status: number | null;
}

interface MemoryProofSnapshot {
	includeSensitiveTopics: boolean;
	longTermEnabled: string | null;
	memories: MemoryFixtureRow[];
	preferences: Record<string, string>;
	requests: CapturedRequest[];
	tauriCalls: Array<{ args: unknown; command: string }>;
}

interface MemoryProofState {
	armFailure: (method: string, path: string, status?: number) => void;
	requests: CapturedRequest[];
	snapshot: () => MemoryProofSnapshot;
	tauriCalls: Array<{ args: unknown; command: string }>;
}

declare global {
	interface Window {
		__memorySettingsProof: MemoryProofState;
	}
}

const queryClient = new QueryClient({
	defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
});

const memoryRowsSchema = z.array(
	z.object({
		author_agent_id: z.string().nullable(),
		category: z.enum([
			"user_fact",
			"preference",
			"domain_knowledge",
			"organization",
			"project_context",
			"relationship",
			"directive",
			"procedure",
			"event",
			"other",
		]),
		content: z.string(),
		created_at: z.number(),
		id: z.string(),
		importance: z.number(),
		scope: z.enum(["agent", "user", "node", "project", "org"]),
		scope_id: z.string().nullable(),
		sensitive_topics: z.array(z.string()),
		tags: z.array(z.string()),
		updated_at: z.number(),
		when_to_use: z.string().nullable(),
	})
) satisfies z.ZodType<MemoryFixtureRow[]>;
const preferencesSchema = z.record(z.string(), z.string());
function readObject<T>(key: string, fallback: T, schema: z.ZodType<T>): T {
	try {
		const stored = localStorage.getItem(key);
		return stored === null ? fallback : schema.parse(JSON.parse(stored));
	} catch {
		return fallback;
	}
}

function writeObject<FixturePayload>(key: string, value: FixturePayload): void {
	localStorage.setItem(key, JSON.stringify(value));
}

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function memoryRow(input: {
	content: string;
	id: string;
	sensitive?: boolean;
}): MemoryFixtureRow {
	return {
		author_agent_id: null,
		category: "user_fact",
		content: input.content,
		created_at: 1_800_000_000_000,
		id: input.id,
		importance: 3,
		scope: "user",
		scope_id: null,
		sensitive_topics: input.sensitive ? ["health_condition"] : [],
		tags: [],
		updated_at: 1_800_000_000_000,
		when_to_use: null,
	};
}

function initialMemoryRows(): MemoryFixtureRow[] {
	return [
		memoryRow({
			content: "Project Atlas uses concise weekly status summaries.",
			id: "memory-fixture-project",
		}),
		memoryRow({
			content: "Sensitive fixture: a health condition requires accommodation.",
			id: "memory-fixture-sensitive",
			sensitive: true,
		}),
	];
}

function memoryManifest() {
	return {
		built_in: true,
		companion: null,
		enabled: true,
		id: "@ryu/memory",
		installed: true,
		installed_version: "1.0.0",
		local_only: true,
		name: "Memory",
		permission_grants: [],
		runnables: [],
		// Core's `list_apps` always stamps these two derived keys (null and
		// false for a plugin without a system sidecar), and the Desktop roster
		// schema requires them; without them the roster is refused and the
		// Plugins nav falls back to the raw plugin id.
		sidecar_name: null,
		version: "1.0.0",
		windows_first: false,
	};
}

function memorySettingsTab() {
	return {
		app_enabled: true,
		id: "memory.settings",
		plugin: "@ryu/memory",
		scope: "node",
		title: "Memory",
		view: "memory",
	};
}

function initialCatalog(): PiCatalog {
	return {
		agentModelOverrides: {},
		apiTypes: ["openai-completions"],
		providers: [
			{
				active: true,
				api: "openai-completions",
				authEnv: "",
				authKind: "none",
				configured: true,
				custom: false,
				id: "local",
				label: "Local",
				modelOverrides: {},
				routing: "direct",
				suggestedModels: ["qwen-local"],
				supportsDiscovery: false,
			},
		],
		thinkingLevels: ["low", "high"],
	};
}

function installFixture(): void {
	const params = new URLSearchParams(window.location.search);
	if (params.get("reset") === "true") {
		for (const key of [
			PREFERENCES_KEY,
			MEMORY_SETTINGS_KEY,
			MEMORY_ROWS_KEY,
			LONG_TERM_KEY,
		]) {
			localStorage.removeItem(key);
		}
		params.delete("reset");
		const query = params.toString();
		window.history.replaceState(
			null,
			"",
			`${window.location.pathname}${query ? `?${query}` : ""}`
		);
	}
	if (!localStorage.getItem(MEMORY_ROWS_KEY)) {
		writeObject(MEMORY_ROWS_KEY, initialMemoryRows());
	}
	let includeSensitiveTopics =
		localStorage.getItem(MEMORY_SETTINGS_KEY) === "true";
	const failures = new Map<string, number>();
	const requests: CapturedRequest[] = [];
	const tauriCalls: Array<{ args: unknown; command: string }> = [];
	const state: MemoryProofState = {
		armFailure: (method, path, status = 503) => {
			failures.set(
				`${method.toUpperCase()} ${decodeURIComponent(path)}`,
				status
			);
		},
		requests,
		snapshot: () => ({
			includeSensitiveTopics,
			longTermEnabled: localStorage.getItem(LONG_TERM_KEY),
			memories: structuredClone(
				readObject(MEMORY_ROWS_KEY, initialMemoryRows(), memoryRowsSchema)
			),
			preferences: structuredClone(
				readObject(PREFERENCES_KEY, {}, preferencesSchema)
			),
			requests: structuredClone(requests),
			tauriCalls: structuredClone(tauriCalls),
		}),
		tauriCalls,
	};
	window.__memorySettingsProof = state;
	useGatewayDialog.setState({ open: false, section: "overview" });
	const tauriWindow = window;
	const proofTauriKernel = {
		invoke: async <Arguments,>(command: string, args?: Arguments) => {
			tauriCalls.push({ args: args ?? null, command });
			return undefined;
		},
		transformCallback: () => 1,
	};
	// SAFETY: This browser fixture installs the exact complete private kernel constructed above.
	// This mutation view owns that two-method fixture slot, not the public Tauri SDK result ABI.
	(
		tauriWindow as Omit<typeof window, "__TAURI_INTERNALS__"> & {
			__TAURI_INTERNALS__: typeof proofTauriKernel;
		}
	).__TAURI_INTERNALS__ = proofTauriKernel;

	window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = input instanceof Request ? input : null;
		const rawUrl = isNativeText(input)
			? input
			: input instanceof URL
				? input.toString()
				: (request?.url ?? input.toString());
		const url = new URL(rawUrl, window.location.href);
		const path = decodeURIComponent(url.pathname);
		const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
		const body = isNativeText(init?.body) ? parseProofJson(init.body) : null;
		const record: CapturedRequest = { body, method, path, status: null };
		if (path.startsWith("/api/")) {
			requests.push(record);
		}
		const failureKey = `${method} ${path}`;
		const failureStatus = failures.get(failureKey);
		if (failureStatus !== undefined) {
			failures.delete(failureKey);
			record.status = failureStatus;
			return json({ error: "memory_settings_fixture_failure" }, failureStatus);
		}

		if (path === "/api/auth/get-session") {
			record.status = 200;
			return json({ session: null, user: null });
		}
		if (path === "/api/gateway/status") {
			record.status = 200;
			return json({ reachable: false, url: API_BASE });
		}
		if (path === "/api/plugins") {
			record.status = 200;
			return json({ apps: [memoryManifest()] });
		}
		if (path === "/api/plugins/contributions") {
			record.status = 200;
			return json({ settings_tabs: [memorySettingsTab()] });
		}
		if (path === "/api/memory/settings") {
			if (method === "PUT") {
				const next =
					z.object({ include_sensitive_topics: z.boolean() }).safeParse(body)
						.data?.include_sensitive_topics ?? false;
				includeSensitiveTopics = next;
				localStorage.setItem(MEMORY_SETTINGS_KEY, String(next));
				record.status = 200;
				return json({ include_sensitive_topics: next });
			}
			record.status = 200;
			return json({ include_sensitive_topics: includeSensitiveTopics });
		}
		if (path === "/api/preferences" || path.startsWith("/api/preferences/")) {
			const key = decodeURIComponent(
				path === "/api/preferences"
					? ""
					: path.slice("/api/preferences/".length)
			);
			const preferences = readObject<Record<string, string>>(
				PREFERENCES_KEY,
				{},
				preferencesSchema
			);
			if (method === "PUT") {
				const value =
					z.object({ value: z.string() }).safeParse(body).data?.value ?? null;
				if (!isNativeText(value)) {
					record.status = 400;
					return json({ error: "invalid_preference_payload" }, 400);
				}
				preferences[key] = value;
				writeObject(PREFERENCES_KEY, preferences);
				record.status = 200;
				return json({ key, ok: true, value });
			}
			record.status = 200;
			return json({ key, value: preferences[key] ?? null });
		}
		if (path === "/api/memory") {
			if (method === "POST") {
				const content =
					z.object({ content: z.string() }).safeParse(body).data?.content ?? "";
				const memories = readObject(MEMORY_ROWS_KEY, [], memoryRowsSchema);
				const created = memoryRow({
					content,
					id: `memory-fixture-${memories.length + 1}`,
				});
				memories.push(created);
				writeObject(MEMORY_ROWS_KEY, memories);
				record.status = 201;
				return json({ memory: created }, 201);
			}
			record.status = 200;
			return json({
				memories: readObject(MEMORY_ROWS_KEY, [], memoryRowsSchema),
			});
		}
		if (path === "/api/retrieval/search" && method === "POST") {
			const query =
				z.object({ query: z.string() }).safeParse(body).data?.query ?? "";
			const normalized = query.toLowerCase();
			const memories = readObject<MemoryFixtureRow[]>(
				MEMORY_ROWS_KEY,
				initialMemoryRows(),
				memoryRowsSchema
			);
			const memoryChunks = memories
				.filter(
					(memory) =>
						(!memory.sensitive_topics.length || includeSensitiveTopics) &&
						memory.content.toLowerCase().includes(normalized)
				)
				.map((memory, index) => ({
					content: memory.content,
					id: `memory:${memory.id}`,
					score: 0.93 - index * 0.02,
					source: "memory",
					space_id: null,
				}));
			const spaceChunks = normalized.includes("project")
				? [
						{
							content:
								"A local fixture document describes the project handoff.",
							id: "space:chunk-fixture-space",
							score: 0.81,
							source: "space",
							space_id: "space-fixture",
						},
					]
				: [];
			const chunks = normalized.includes("no-match")
				? []
				: [...memoryChunks, ...spaceChunks];
			record.status = 200;
			return json({ chunks });
		}
		if (path === "/api/spaces") {
			record.status = 200;
			return json({ spaces: [{ id: "space-fixture", name: "Fixture docs" }] });
		}
		if (path === "/api/pi-config/catalog") {
			record.status = 200;
			return json(initialCatalog());
		}
		if (path === "/api/agents") {
			record.status = 200;
			return json({ agents: [] });
		}
		if (path === "/api/engines") {
			record.status = 200;
			return json({ engines: [] });
		}
		if (path === "/api/engines/active") {
			record.status = 200;
			return json({ engine: null });
		}
		if (path.startsWith("/api/")) {
			record.status = 404;
			return json({ error: `Unhandled fixture API: ${method} ${path}` }, 404);
		}
		record.status = 404;
		return json(
			{ error: `Unexpected fixture request: ${method} ${path}` },
			404
		);
	};
}

function ProofSurface() {
	const open = useGatewayDialog((state) => state.open);
	const section = useGatewayDialog((state) => state.section);
	const setOpen = useGatewayDialog((state) => state.setOpen);
	return (
		<AppSurfaceProvider surface="desktop">
			<EntitlementProvider>
				<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
					<main className="mx-auto min-h-screen max-w-5xl bg-background p-8 text-foreground">
						<header className="mb-6">
							<p className="text-muted-foreground text-xs tracking-widest">
								RYU · MEMORY SETTINGS PROOF
							</p>
							<h1 className="mt-2 font-semibold text-2xl">Memory settings</h1>
							<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
								Production Gateway → Plugins → Memory settings with isolated
								Core, preference, retrieval and durable-memory fixtures. No user
								files or local memory repositories are used.
							</p>
							<button
								className="mt-4 rounded-lg border bg-card px-3 py-2 text-sm"
								onClick={() => useGatewayDialog.getState().openGateway()}
								type="button"
							>
								Open Gateway settings
							</button>
						</header>
					</main>
					<GatewayDialog
						defaultSection={section}
						onOpenChange={setOpen}
						open={open}
					/>
					<Toaster position="bottom-right" theme="system" />
				</ThemeProvider>
			</EntitlementProvider>
		</AppSurfaceProvider>
	);
}

useNodeStore.setState({
	cloudNodes: [],
	defaultNode: NODE.name,
	localNodes: [NODE],
	nodes: [NODE],
});
setInterfaceLevel("expert");
installFixture();

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<QueryClientProvider client={queryClient}>
			<I18nProvider>
				<MemoryRouter>
					<ProofSurface />
				</MemoryRouter>
			</I18nProvider>
		</QueryClientProvider>
	);
}
