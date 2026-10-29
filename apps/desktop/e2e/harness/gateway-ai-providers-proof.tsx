import { z } from "zod";
import { parseProofJsonRecord } from "../fixture-json.ts";
import {
	gatewayRoutingProofSchema,
	piCatalogProofSchema,
	piConfigProofSchema,
} from "./gateway-proof-contracts.ts";

declare const window: Window;

import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { ProviderControlCenter } from "../../src/components/gateway/ProviderControlCenter.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import type {
	PiCatalog,
	PiConfig,
	PiLoginEvent,
} from "../../src/lib/api/pi-config.ts";
import { setInterfaceLevel } from "../../src/lib/interface-level.ts";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import { useGatewayDialog } from "../../src/store/useGatewayDialog.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { useSettingsDialog } from "../../src/store/useSettingsDialog.ts";
import "../../src/index.css";

// Gateway opens only in Console; grant the access App's ProductModeAccessSync
// would grant a local node.
useProductModeStore.setState({ requestedMode: "console", consoleAccess: true });

const NODE = {
	managed: false,
	name: "gateway-ai-providers-proof",
	orgId: null,
	token: null,
	url: "http://127.0.0.1:7980",
	userJwt: null,
};
const STORAGE_KEY = "gateway-ai-providers-proof-state";

interface RequestRecord {
	body: unknown;
	method: string;
	path: string;
}

interface TauriCallRecord {
	args?: unknown;
	command: string;
	failed: boolean;
}

interface ProofSnapshot {
	catalog: PiCatalog;
	config: PiConfig;
	gatewayConfig: { routing: z.infer<typeof gatewayRoutingProofSchema> };
	navigation: Array<{ open: boolean; section: string }>;
	preferences: Record<string, string>;
	requests: RequestRecord[];
	settingsNavigation: Array<{ open: boolean; section: string }>;
	tauriCalls: TauriCallRecord[];
}

interface ProofState {
	armFailure: (operation: string) => void;
	failNextExternalLaunch: () => void;
	requests: RequestRecord[];
	snapshot: () => ProofSnapshot;
}

declare global {
	interface Window {
		__gatewayAiProvidersProof: ProofState;
	}
}

const account = {
	accountId: "openai-work",
	active: true,
	gatewayActive: false,
	kind: "api_key",
	label: "work@example.com",
	updatedAt: 1_790_000_000_000,
};

function initialCatalog(): PiCatalog {
	return {
		agentModelOverrides: {},
		apiTypes: ["openai-completions", "openai-responses"],
		providers: [
			{
				accounts: [structuredClone(account)],
				active: false,
				api: "openai-completions",
				authEnv: "OPENAI_API_KEY",
				authKind: "api-key",
				configured: false,
				custom: false,
				id: "openai",
				label: "OpenAI",
				modelOverrides: {},
				routing: "direct",
				suggestedModels: ["gpt-4o-mini", "gpt-4.1-mini"],
				supportsDiscovery: true,
			},
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
			{
				active: false,
				api: "anthropic-messages",
				authEnv: "",
				authKind: "subscription",
				configured: false,
				custom: false,
				id: "claude-code",
				label: "Claude Code",
				modelOverrides: {},
				routing: "gateway",
				routingLocked: true,
				suggestedModels: ["claude-sonnet-4"],
				supportsDiscovery: false,
			},
			{
				active: false,
				api: "openai-completions",
				authEnv: "",
				authKind: "none",
				configured: true,
				creditPool: "openrouter",
				custom: false,
				id: "managed-openrouter",
				label: "Ryu Managed",
				managed: true,
				modelOverrides: {},
				routing: "gateway",
				routingLocked: true,
				suggestedModels: ["openrouter/auto"],
				supportsDiscovery: false,
			},
		],
		thinkingLevels: ["low", "high"],
	};
}

function initialConfig(): PiConfig {
	return {
		configDir: "/fixture/pi-config",
		model: "qwen-local",
		provider: "local",
		providerRouting: { openai: "direct" },
		routing: "direct",
		thinkingLevel: null,
	};
}

function initialGatewayConfig() {
	return {
		routing: gatewayRoutingProofSchema.parse({
			default_provider: "openai",
			fallback_chain: ["local"],
			model_map: {},
			modality_map: {
				image: { model: "flux-fast", provider: "fal" },
				stt: { provider: "local" },
				tts: { model: "speech-1", provider: "openai" },
				video: { model: "video-fast", provider: "replicate" },
			},
		}),
	};
}

function freshSnapshot(): ProofSnapshot {
	return {
		catalog: initialCatalog(),
		config: initialConfig(),
		gatewayConfig: initialGatewayConfig(),
		navigation: [],
		preferences: { "replicate-api-key": "", "fal-api-key": "fal-fixture-key" },
		requests: [],
		settingsNavigation: [],
		tauriCalls: [],
	};
}

const requestRecordSchema = z.object({
	body: z.json(),
	method: z.string(),
	path: z.string(),
});
const navigationSchema = z.array(
	z.object({ open: z.boolean(), section: z.string() })
);
const proofSnapshotSchema = z.object({
	catalog: piCatalogProofSchema,
	config: piConfigProofSchema,
	gatewayConfig: z.object({ routing: gatewayRoutingProofSchema }),
	navigation: navigationSchema,
	preferences: z.record(z.string(), z.string()),
	requests: z.array(requestRecordSchema),
	settingsNavigation: navigationSchema,
	tauriCalls: z.array(
		z.object({
			args: z.json().optional(),
			command: z.string(),
			failed: z.boolean(),
		})
	),
});
function readPersisted(): ProofSnapshot {
	const stored = localStorage.getItem(STORAGE_KEY);
	if (!stored) {
		const initial = freshSnapshot();
		localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
		return initial;
	}
	return proofSnapshotSchema.parse(JSON.parse(stored));
}

function persist(next: ProofSnapshot): void {
	localStorage.setItem(
		STORAGE_KEY,
		JSON.stringify({ ...next, requests: [], tauriCalls: [] })
	);
}

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function catalogWithActive(catalog: PiCatalog, config: PiConfig): PiCatalog {
	return {
		...catalog,
		providers: catalog.providers.map((provider) => ({
			...provider,
			active: provider.id === config.provider,
		})),
	};
}

function installCoreFixture(): void {
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
	let nextFailure = "";
	const tauriCalls: TauriCallRecord[] = [];
	const fail = (operation: string) => {
		if (nextFailure !== operation) {
			return false;
		}
		nextFailure = "";
		return true;
	};
	let loginStreamController: ReadableStreamDefaultController<Uint8Array> | null =
		null;
	const requests: RequestRecord[] = [];
	const state: ProofState = {
		armFailure: (operation) => {
			nextFailure = operation;
		},
		failNextExternalLaunch: () => {
			nextFailure = "external-open";
		},
		requests,
		snapshot: () =>
			structuredClone({ ...readPersisted(), requests, tauriCalls }),
	};
	window.__gatewayAiProvidersProof = state;
	const tauriWindow = window;
	const proofTauriKernel = {
		invoke: async <Arguments,>(command: string, args?: Arguments) => {
			const failed = command === "open_external" && fail("external-open");
			tauriCalls.push({ args: args ?? null, command, failed });
			if (failed) {
				throw new Error("fixture_browser_unavailable");
			}
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
	useGatewayDialog.subscribe((value) => {
		const persisted = readPersisted();
		persisted.navigation.push({ open: value.open, section: value.section });
		persist(persisted);
	});
	useSettingsDialog.subscribe((value) => {
		const persisted = readPersisted();
		persisted.settingsNavigation.push({
			open: value.open,
			section: value.section,
		});
		persist(persisted);
	});

	window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const rawUrl = isNativeText(input)
			? input
			: input instanceof Request
				? input.url
				: input.toString();
		const { pathname } = new URL(rawUrl, window.location.href);
		const method = (init?.method ?? "GET").toUpperCase();
		const body = isNativeText(init?.body)
			? parseProofJsonRecord(init.body)
			: null;
		requests.push({ body, method, path: pathname });
		const stored = readPersisted();
		const responseCatalog = () =>
			json(catalogWithActive(stored.catalog, stored.config));

		if (pathname.endsWith("/api/pi-config/catalog") && method === "GET") {
			return responseCatalog();
		}
		const loginStart = pathname.match(
			/\/api\/pi-config\/providers\/([^/]+)\/login$/u
		);
		if (loginStart && method === "POST") {
			if (fail("login-start")) {
				return json({ error: "provider_login_unavailable" }, 503);
			}
			return json({ sessionId: "provider-login-session" });
		}
		if (
			pathname === "/api/pi-config/login/provider-login-session/events" &&
			method === "GET"
		) {
			const encoder = new TextEncoder();
			const loginFlow = params.get("loginFlow");
			const initialEvent: PiLoginEvent =
				loginFlow === "auth-url"
					? {
							type: "auth_url",
							url: "https://login.example.test/authorize?state=fixture-state",
							instructions:
								"Approve access in the browser, then return to Ryu.",
						}
					: loginFlow === "device-code"
						? {
								type: "device_code",
								userCode: "ABCD-EFGH",
								verificationUri: "https://login.example.test/device",
							}
						: params.get("loginPrompt") === "text"
							? {
									type: "prompt",
									id: "manual-code",
									prompt: {
										message: "Enter the verification code",
										placeholder: "Paste the code here",
										type: "text",
									},
								}
							: {
									type: "prompt",
									id: "choose-profile",
									prompt: {
										message: "Choose the subscription profile",
										type: "select",
										options: [
											{ id: "personal", label: "Personal subscription" },
											{ id: "work", label: "Work subscription" },
										],
									},
								};
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					loginStreamController = controller;
					controller.enqueue(
						encoder.encode(`data: ${JSON.stringify(initialEvent)}\n\n`)
					);
				},
				cancel() {
					loginStreamController = null;
				},
			});
			return new Response(stream, {
				headers: { "content-type": "text/event-stream" },
			});
		}
		const loginAnswer = pathname.match(
			/\/api\/pi-config\/login\/([^/]+)\/answer$/u
		);
		if (loginAnswer && method === "POST") {
			if (fail("login-answer")) {
				return json({ accepted: false, error: "profile_rejected" });
			}
			const catalog = structuredClone(stored.catalog);
			const provider = catalog.providers.find(
				(item) => item.id === "claude-code"
			);
			if (provider) {
				provider.configured = true;
				provider.accounts = [
					{
						accountId: "claude-work",
						active: true,
						kind: "oauth",
						label: "work@example.com",
						updatedAt: Date.now(),
					},
				];
			}
			persist({ ...stored, catalog });
			loginStreamController?.enqueue(
				new TextEncoder().encode(
					`data: ${JSON.stringify({ type: "success", provider: "claude-code" })}\n\n`
				)
			);
			loginStreamController?.close();
			loginStreamController = null;
			return json({ accepted: true });
		}
		const loginCancel = pathname.match(
			/\/api\/pi-config\/login\/([^/]+)\/cancel$/u
		);
		if (loginCancel && method === "POST") {
			try {
				loginStreamController?.close();
			} catch {
				// The fixture may already have closed the stream after success.
			}
			loginStreamController = null;
			return json({ cancelled: true });
		}
		if (pathname.endsWith("/api/pi-config") && method === "GET") {
			return json({ config: stored.config });
		}
		if (pathname.endsWith("/api/pi-config") && method === "PUT") {
			if (fail("activate")) {
				return json({ error: "provider_activation_unavailable" }, 503);
			}
			const nextConfig = piConfigProofSchema.parse({
				...stored.config,
				...body,
			});
			persist({ ...stored, config: nextConfig });
			return json({ config: nextConfig });
		}
		if (
			pathname.endsWith("/api/pi-config/providers/check") &&
			method === "POST"
		) {
			if (fail("check")) {
				return json({ error: "provider_probe_unavailable" }, 503);
			}
			return json({ latencyMs: 14, modelCount: 3, ok: true });
		}
		if (
			pathname.endsWith("/api/pi-config/discover-models") &&
			method === "POST"
		) {
			if (fail("discover")) {
				return json({ error: "model_discovery_unavailable" }, 503);
			}
			return json({
				models: [
					{ id: "gpt-4.1-mini", name: "GPT-4.1 mini" },
					{ id: "gpt-4.1", name: "GPT-4.1" },
				],
				source: "discovery",
			});
		}
		if (
			pathname.endsWith("/api/pi-config/providers/model-enabled") &&
			method === "POST"
		) {
			if (fail("model-enabled")) {
				return json({ error: "model_visibility_unavailable" }, 503);
			}
			const providerId = String(body?.provider ?? "");
			const modelId = String(body?.model ?? "");
			const enabled = body?.enabled === true;
			const catalog = structuredClone(stored.catalog);
			if (providerId.startsWith("agent:")) {
				const agentId = providerId.slice("agent:".length);
				catalog.agentModelOverrides ??= {};
				catalog.agentModelOverrides[agentId] ??= {};
				catalog.agentModelOverrides[agentId][modelId] = enabled;
			} else {
				const provider = catalog.providers.find(
					(entry) => entry.id === providerId
				);
				if (provider) {
					provider.modelOverrides ??= {};
					provider.modelOverrides[modelId] = enabled;
				}
			}
			persist({ ...stored, catalog });
			return json(catalogWithActive(catalog, stored.config));
		}
		if (pathname.endsWith("/api/pi-config/providers") && method === "POST") {
			if (fail("configure")) {
				return json({ error: "provider_configuration_unavailable" }, 503);
			}
			const providerId = String(body?.provider ?? "");
			const catalog = structuredClone(stored.catalog);
			const existing = catalog.providers.find(
				(entry) => entry.id === providerId
			);
			if (existing) {
				if (isNativeText(body?.apiKey) && body.apiKey.trim()) {
					existing.configured = true;
				}
				if (isNativeText(body?.routing)) {
					existing.routing = body.routing;
				}
			} else {
				catalog.providers.push({
					active: false,
					api: String(body?.api ?? "openai-completions"),
					authEnv: "",
					authKind: body?.apiKey ? "api-key" : "none",
					configured: Boolean(body?.apiKey),
					custom: true,
					id: providerId,
					label: providerId,
					modelOverrides: {},
					routing: "direct",
					suggestedModels: [],
					supportsDiscovery: true,
				});
			}
			persist({ ...stored, catalog });
			return json(catalogWithActive(catalog, stored.config));
		}
		const accountSwitch = pathname.match(
			/\/api\/pi-config\/providers\/([^/]+)\/accounts\/switch$/u
		);
		if (accountSwitch && method === "POST") {
			if (fail("switch-account")) {
				return json({ error: "account_switch_unavailable" }, 503);
			}
			const providerId = decodeURIComponent(accountSwitch[1] ?? "");
			const accountId = String(body?.accountId ?? "");
			const target = body?.target === "gateway" ? "gateway" : "self";
			const catalog = structuredClone(stored.catalog);
			const provider = catalog.providers.find(
				(entry) => entry.id === providerId
			);
			for (const item of provider?.accounts ?? []) {
				if (target === "gateway") {
					item.gatewayActive = item.accountId === accountId;
				} else {
					item.active = item.accountId === accountId;
				}
			}
			persist({ ...stored, catalog });
			return json(catalogWithActive(catalog, stored.config));
		}
		const accountRemove = pathname.match(
			/\/api\/pi-config\/providers\/([^/]+)\/accounts\/remove$/u
		);
		if (accountRemove && method === "POST") {
			if (fail("remove-account")) {
				return json({ error: "account_removal_unavailable" }, 503);
			}
			const providerId = decodeURIComponent(accountRemove[1] ?? "");
			const accountId = String(body?.accountId ?? "");
			const catalog = structuredClone(stored.catalog);
			const provider = catalog.providers.find(
				(entry) => entry.id === providerId
			);
			if (provider) {
				provider.accounts = (provider.accounts ?? []).filter(
					(item) => item.accountId !== accountId
				);
			}
			persist({ ...stored, catalog });
			return json(catalogWithActive(catalog, stored.config));
		}
		const providerDelete = pathname.match(
			/\/api\/pi-config\/providers\/([^/]+)$/u
		);
		if (providerDelete && method === "DELETE") {
			if (fail("delete-provider")) {
				return json({ error: "provider_removal_unavailable" }, 503);
			}
			const providerId = decodeURIComponent(providerDelete[1] ?? "");
			const catalog = structuredClone(stored.catalog);
			const provider = catalog.providers.find(
				(entry) => entry.id === providerId
			);
			if (provider?.custom) {
				catalog.providers = catalog.providers.filter(
					(entry) => entry.id !== providerId
				);
			} else if (provider) {
				provider.configured = false;
			}
			persist({ ...stored, catalog });
			return json(catalogWithActive(catalog, stored.config));
		}
		if (pathname.endsWith("/api/gateway/config") && method === "GET") {
			return json(stored.gatewayConfig);
		}
		if (pathname.startsWith("/api/preferences/") && method === "GET") {
			const key = decodeURIComponent(
				pathname.slice("/api/preferences/".length)
			);
			return json({ key, value: stored.preferences[key] ?? null });
		}
		if (pathname.endsWith("/api/agents") && method === "GET") {
			return json({
				agents: [
					{
						id: "codex",
						name: "Codex",
						transport: "acp",
						recommended: false,
						avatar_glyph: null,
					},
				],
			});
		}
		if (pathname.endsWith("/api/agents/codex/acp-config") && method === "GET") {
			return json({
				authMethods: [],
				configOptions: [],
				models: {
					availableModels: [{ modelId: "codex-pro", name: "Codex Pro" }],
					currentModelId: "codex-pro",
				},
				modes: null,
			});
		}
		// Entitlement/billing reads are deliberately signed out in this harness.
		// They are not part of provider selection and must not become test writes.
		return json({});
	};
}

function ProofSurface() {
	const queryClient = useMemo(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: { refetchOnWindowFocus: false, retry: false },
				},
			}),
		[]
	);
	const params = new URLSearchParams(window.location.search);
	const managed = params.get("managed") === "true";
	const canSetGatewayAccount = params.get("permission") !== "denied";

	return (
		<QueryClientProvider client={queryClient}>
			<I18nProvider>
				<MemoryRouter>
					<AppSurfaceProvider surface="desktop">
						<EntitlementProvider>
							<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
								<main className="mx-auto min-h-screen max-w-5xl bg-background p-8 text-foreground">
									<header className="mb-5">
										<p className="text-muted-foreground text-xs tracking-widest">
											RYU · LIVE REACT PROOF
										</p>
										<h1 className="mt-2 font-semibold text-2xl">
											Gateway AI providers
										</h1>
										<p className="mt-1 max-w-2xl text-muted-foreground text-sm">
											Rendered ProviderControlCenter with stateful Core
											provider, account, model, and Gateway routing fixtures.
										</p>
									</header>
									<ProviderControlCenter
										canSetGatewayAccount={canSetGatewayAccount}
										credentials={<p>Credential integration slot</p>}
										integrations={<p>Provider integration slot</p>}
										managed={managed}
										routing={<p>Routing integration slot</p>}
									/>
								</main>
								<Toaster position="bottom-right" theme="system" />
							</ThemeProvider>
						</EntitlementProvider>
					</AppSurfaceProvider>
				</MemoryRouter>
			</I18nProvider>
		</QueryClientProvider>
	);
}

useNodeStore.setState({
	cloudNodes: [],
	defaultNode: NODE.name,
	localNodes: [NODE],
	nodes: [NODE],
});
setInterfaceLevel("expert");
installCoreFixture();

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<ProofSurface />);
}
