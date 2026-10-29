declare const window: Window;

import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { PluginSettingsFields } from "../../src/components/settings/PluginSettingsFields.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import type {
	PluginSettingsField,
	PluginSettingsTab,
} from "../../src/lib/pluginSettings.ts";
import { queryClient } from "../../src/lib/query-client.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { parseProofJsonRecord } from "../fixture-json.ts";
import "../../src/index.css";

const STORAGE_KEY = "ryu-plugin-settings-fields-proof";
const PLUGIN_ID = "com.ryu.proof";
const PROOF_AVATAR =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='8' fill='%230ea5e9'/%3E%3C/svg%3E";
const NODE = {
	managed: false,
	name: "plugin-settings-proof",
	orgId: null,
	token: "plugin-settings-proof-token",
	url: window.location.origin,
	userJwt: null,
};
const INITIAL_PREFERENCES = {
	"proof.mode": "standard",
	"proof.summary": "Existing endpoint",
	"proof.instructions": "Existing prompt",
	"proof.retry-count": "3",
};

const FIELDS: PluginSettingsField[] = [
	{
		label: "Enable fixture feature",
		prefKey: "proof.enabled",
		options: [],
		type: "toggle",
		default: false,
	},
	{
		label: "Output mode",
		prefKey: "proof.mode",
		options: [
			{ value: "standard", label: "Standard" },
			{ value: "strict", label: "Strict" },
		],
		type: "select",
	},
	{
		label: "Service endpoint",
		prefKey: "proof.summary",
		options: [],
		placeholder: "https://service.example",
		type: "text",
	},
	{
		label: "System instructions",
		prefKey: "proof.instructions",
		options: [],
		placeholder: "Instructions for this plugin",
		type: "textarea",
	},
	{
		label: "Max attempts",
		prefKey: "proof.retry-count",
		options: [],
		min: 1,
		max: 9,
		step: 2,
		type: "number",
		default: 3,
	},
	{
		label: "API token",
		prefKey: "RYU_PLUGIN_PROOF_API_KEY",
		options: [],
		type: "secret",
	},
	{
		label: "Preferred model",
		prefKey: "proof.default-model",
		options: [],
		type: "model_picker",
	},
	{
		label: "Default agent target",
		prefKey: "proof.default-agent",
		options: [],
		type: "agent_picker",
	},
	{
		label: "Empty-select fallback",
		prefKey: "proof.empty-select",
		options: [],
		placeholder: "Type a fallback value",
		type: "select",
	},
	{
		label: "Future field fallback",
		prefKey: "proof.future-field",
		options: [],
		placeholder: "Unknown types remain editable",
		type: "future_field",
	},
];

const TABS: PluginSettingsTab[] = [
	{
		id: "proof.settings",
		plugin: PLUGIN_ID,
		title: "Fixture settings",
		scope: "node",
		enabled: true,
		fields: FIELDS,
	},
];

interface RequestRecord {
	body: unknown;
	method: string;
	path: string;
}

interface SecretRecord {
	readable: boolean;
	set: boolean;
	updated_at: number | null;
	value?: string;
}

interface StoredFixture {
	preferences: Record<string, string>;
	secrets: Record<string, SecretRecord>;
}

interface FailurePlan {
	method: string;
	path: string;
}

interface PluginSettingsProofApi {
	armFailure: (method: string, path: string) => void;
	clearRequestLog: () => void;
	releaseSecretRead: () => void;
	snapshot: () => {
		preferences: Record<string, string>;
		requests: RequestRecord[];
		secretStates: Record<string, Omit<SecretRecord, "value">>;
		externalRequests: string[];
	};
}

declare global {
	interface Window {
		__pluginSettingsFieldsProof: PluginSettingsProofApi;
	}
}

function initialState(): StoredFixture {
	return { preferences: { ...INITIAL_PREFERENCES }, secrets: {} };
}

function readState(): StoredFixture {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw ? JSON.parse(raw) : initialState();
	} catch {
		return initialState();
	}
}

function writeState(state: StoredFixture): void {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function jsonResponse<FixturePayload>(
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
		return parseProofJsonRecord(init.body);
	} catch {
		return init.body;
	}
}

function installedAgents() {
	return [
		{
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
		},
	];
}

function installFixture(): void {
	const params = new URLSearchParams(window.location.search);
	const shouldReset = params.get("reset") === "true";
	const holdFirstSecretRead = params.get("holdSecretRead") === "true";
	if (shouldReset) {
		localStorage.removeItem(STORAGE_KEY);
	}
	params.delete("reset");
	params.delete("holdSecretRead");
	if (shouldReset || holdFirstSecretRead) {
		window.history.replaceState(
			null,
			"",
			`${window.location.pathname}${params.toString() ? `?${params}` : ""}`
		);
	}
	if (!localStorage.getItem(STORAGE_KEY)) {
		writeState(initialState());
	}

	const requests: RequestRecord[] = [];
	const externalRequests: string[] = [];
	let nextFailure: FailurePlan | null = null;
	let holdSecretRead = holdFirstSecretRead;
	let releaseSecretRead: (() => void) | null = null;
	const secretStates = () => {
		const secrets = readState().secrets;
		return Object.fromEntries(
			Object.entries(secrets).map(([key, state]) => [
				key,
				{
					readable: state.readable,
					set: state.set,
					updated_at: state.updated_at,
				},
			])
		);
	};
	window.__pluginSettingsFieldsProof = {
		armFailure: (method, path) => {
			nextFailure = { method: method.toUpperCase(), path };
		},
		clearRequestLog: () => {
			requests.length = 0;
			externalRequests.length = 0;
		},
		releaseSecretRead: () => releaseSecretRead?.(),
		snapshot: () => ({
			preferences: structuredClone(readState().preferences),
			requests: structuredClone(requests),
			secretStates: structuredClone(secretStates()),
			externalRequests: structuredClone(externalRequests),
		}),
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
		if (url.origin !== window.location.origin) {
			externalRequests.push(url.href);
			return jsonResponse(
				{ error: "external_request_blocked_by_local_fixture" },
				503
			);
		}
		if (!url.pathname.startsWith("/api/")) {
			return realFetch(input, init);
		}

		const body = parseBody(init);
		requests.push({ body, method, path: url.pathname });
		if (nextFailure?.method === method && nextFailure.path === url.pathname) {
			nextFailure = null;
			return jsonResponse(
				{ error: "Local fixture refused this write once." },
				503
			);
		}

		if (url.pathname.startsWith("/api/preferences/") && method === "GET") {
			const key = decodeURIComponent(
				url.pathname.slice("/api/preferences/".length)
			);
			const value = readState().preferences[key];
			return value === undefined
				? jsonResponse({ error: "preference_not_found" }, 404)
				: jsonResponse({ key, value });
		}
		if (url.pathname.startsWith("/api/preferences/") && method === "PUT") {
			const key = decodeURIComponent(
				url.pathname.slice("/api/preferences/".length)
			);
			const parsedValue = z.object({ value: z.string() }).safeParse(body);
			const value = parsedValue.success ? parsedValue.data.value : null;
			if (!isNativeText(value)) {
				return jsonResponse({ error: "value_must_be_string" }, 400);
			}
			const state = readState();
			state.preferences[key] = value;
			writeState(state);
			return jsonResponse({ key, value });
		}
		if (
			url.pathname === `/api/plugins/${PLUGIN_ID}/secrets` &&
			method === "GET"
		) {
			const secrets = Object.entries(readState().secrets).map(
				([key, secret]) => ({
					key,
					readable: secret.readable,
					set: secret.set,
					updated_at: secret.updated_at,
				})
			);
			if (holdSecretRead) {
				holdSecretRead = false;
				await new Promise<void>((resolve) => {
					releaseSecretRead = resolve;
				});
				releaseSecretRead = null;
			}
			return jsonResponse({ secrets });
		}
		const secretPrefix = `/api/plugins/${PLUGIN_ID}/secrets/`;
		if (url.pathname.startsWith(secretPrefix)) {
			const key = decodeURIComponent(url.pathname.slice(secretPrefix.length));
			if (method === "PUT") {
				const parsedValue = z.object({ value: z.string() }).safeParse(body);
				const value = parsedValue.success ? parsedValue.data.value : null;
				if (!isNativeText(value)) {
					return jsonResponse({ error: "secret_must_be_string" }, 400);
				}
				const state = readState();
				state.secrets[key] = {
					readable: true,
					set: true,
					updated_at: Date.now(),
					value,
				};
				writeState(state);
				return jsonResponse({ ok: true });
			}
			if (method === "DELETE") {
				const state = readState();
				delete state.secrets[key];
				writeState(state);
				return jsonResponse({ ok: true });
			}
		}
		if (url.pathname === "/api/agents" && method === "GET") {
			return jsonResponse({ agents: installedAgents() });
		}
		if (url.pathname === "/api/engines" && method === "GET") {
			return jsonResponse({
				engines: [{ id: "pi", name: "Pi", installed: true }],
			});
		}
		if (url.pathname === "/api/engine/active" && method === "GET") {
			return jsonResponse({ active: "pi", available: ["pi"], running: true });
		}
		if (url.pathname === "/api/engines/models" && method === "GET") {
			return jsonResponse({
				models: { pi: [{ id: "proof-model", name: "Proof Model" }] },
			});
		}
		if (url.pathname === "/api/pi-config/catalog" && method === "GET") {
			return jsonResponse({
				apiTypes: ["openai-completions"],
				providers: [
					{
						api: "openai-completions",
						authEnv: "OPENAI_API_KEY",
						authKind: "api-key",
						configured: true,
						custom: false,
						id: "openai",
						label: "OpenAI",
						routing: "direct",
						suggestedModels: ["proof-model", "gpt-5-mini"],
						supportsDiscovery: false,
					},
				],
				thinkingLevels: ["low", "medium", "high"],
			});
		}
		if (url.pathname.endsWith("/capabilities")) {
			return jsonResponse({
				capabilities: {
					model: null,
					reasoning: true,
					tools: true,
					vision: true,
				},
			});
		}
		return jsonResponse({});
	};
	window.fetch = proofFetch;
}

useNodeStore.setState({
	defaultNode: NODE.name,
	localNodes: [NODE],
	nodes: [NODE],
});

queryClient.clear();

function ProofSurface() {
	return (
		<ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
			<QueryClientProvider client={queryClient}>
				<EntitlementProvider>
					<TooltipProvider>
						<main className="min-h-screen bg-background p-8 text-foreground">
							<div className="mx-auto max-w-5xl space-y-6">
								<header className="rounded-2xl border bg-card p-6 shadow-sm">
									<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
										Production PluginSettingsFields · stateful local Core
										fixture
									</p>
									<h1 className="mt-2 font-semibold text-2xl">
										Plugin settings
									</h1>
									<p className="mt-2 text-muted-foreground text-sm">
										The real declarative settings fields talk only to an
										isolated local fixture; no plugin runtime, account,
										provider, or external service is used.
									</p>
								</header>
								<PluginSettingsFields tabs={TABS} target={NODE} />
							</div>
						</main>
						<Toaster position="bottom-right" theme="light" />
					</TooltipProvider>
				</EntitlementProvider>
			</QueryClientProvider>
		</ThemeProvider>
	);
}

installFixture();

const root = document.getElementById("root");
if (!root) {
	throw new Error("Plugin settings proof root not found.");
}
createRoot(root).render(<ProofSurface />);
document.body.dataset.harnessReady = "1";
