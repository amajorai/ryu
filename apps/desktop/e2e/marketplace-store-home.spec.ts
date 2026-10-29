import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";
import type {
	AppPresentation,
	CatalogEntry,
	PluginContributions,
} from "../src/lib/api/plugins.ts";
import type { StoreProofJson } from "./marketplace-store-home-proof.contracts.ts";
import {
	gatewayMarketplaceUpdateObservation,
	storeEffectsSchema,
	storeIdRequestSchema,
	storeLikeRequestSchema,
	storeLikesBatchSchema,
	storeModelInstallSchema,
	storeNameRequestSchema,
	storePluginInstallSchema,
	storePluginUpdateSchema,
	storePreferenceRequestSchema,
	storeProofJsonSchema,
	storeRecommendationPreferenceSchema,
	storeReviewRequestSchema,
	storeSkillActivationSchema,
	storeSkillDistributionSchema,
	storeSkillInstallSchema,
	storeSourceMutationSchema,
	storeSourceReorderSchema,
	storeSourceSelectionSchema,
	storeUrlInstallSchema,
	storeVariantRequestSchema,
} from "./marketplace-store-home-proof.contracts.ts";

const STORY_URL = "/marketplace-store-home.html";
const API_ORIGIN =
	process.env.RYU_STORE_TEST_API_ORIGIN ?? "http://127.0.0.1:5191";
const EVIDENCE_DIR = resolve(
	process.env.RYU_STORE_TEST_PROOF_DIR ??
		resolve(
			import.meta.dirname,
			"../../../docs/proof/test-coverage-sweep-20260924/evidence"
		)
);
mkdirSync(EVIDENCE_DIR, { recursive: true });

interface EngineFixtureDiagnostics {
	fixture: Fixture;
	pageErrors: string[];
	unknown: RequestRecord[];
}
const engineDiagnostics = new WeakMap<Page, EngineFixtureDiagnostics>();

// getPluginContributions consumes this complete array envelope directly.
const EMPTY_ENGINE_CONTRIBUTIONS = {
	backgrounds: [],
	computer_use_planners: [],
	agent_edit_panels: [],
	composer_controls: [],
	chat_features: [],
	chat_widget_templates: [],
	settings_tabs: [],
	message_actions: [],
	selection_actions: [],
	output_styles: [],
	context_menu_items: [],
	create_actions: [],
	slash_commands: [],
	turn_hooks: [],
	hook_events: [],
	views: [],
	sidebar_sections: [],
	sidebar_modes: [],
	sidebar_buttons: [],
	themes: [],
	dock_panels: [],
	live_activities: [],
	store_tabs: [],
	channels: [],
	companions: [],
	widget_apps: [],
} satisfies PluginContributions;

interface RequestRecord {
	body: StoreProofJson;
	method: string;
	path: string;
	search: string;
}

interface RecommendationFixture {
	cadence: StoreProofJson;
	enabled: boolean;
	hidden: boolean;
	items: Array<{
		description: string;
		id: string;
		installed: boolean;
		kind: string;
		name: string;
		reason: string;
	}>;
}

interface SourceFixture {
	base_url: string | null;
	builtin: boolean;
	display_name: string;
	id: string;
}

interface ReviewFixture {
	body: string | null;
	createdAt: string;
	id: string;
	mine: boolean;
	rating: number;
	title: string | null;
	userName: string | null;
	verifiedPurchase: boolean;
}

interface EngineCatalogFixture {
	category: "media" | "provider" | "voice";
	deprecated: boolean;
	description: string;
	display_name: string;
	latest_version: string;
	name: string;
	platforms: string[];
	supported: boolean;
	update_available: boolean;
}

interface Fixture {
	acceleration: {
		selected: string;
		resolved: string;
		resolvedLabel: string;
		installed: string | null;
		hasGpu: boolean;
		gpuName: string | null;
		vram: string;
		options: Array<{
			id: string;
			label: string;
			available: boolean;
			description: string;
			unavailable_reason: string | null;
		}>;
	};
	accelerationFailures: number;
	accelerationGate: { promise: Promise<void>; release: () => void } | null;
	agentsAdded: Set<string>;
	appCatalogFailures: number;
	appChannels: Record<string, string | null>;
	appEnabled: Set<string>;
	appInstallFailures: number;
	appsInstalled: Set<string>;
	appUrlInstallFailures: number;
	auditFailures: number;
	auditGate: { promise: Promise<void>; release: () => void } | null;
	calls: RequestRecord[];
	engineActionFailures: Record<string, number>;
	engineActionGates: Record<
		string,
		{ promise: Promise<void>; release: () => void }
	>;
	engineActive: string;
	engineCatalogFailures: number;
	engineGatewayRefreshed: boolean;
	engineInstalled: Set<string>;
	engineInstalledVersions: Record<string, string>;
	engineRunning: Record<string, boolean>;
	installFailures: Record<string, number>;
	installGate: { promise: Promise<void>; release: () => void } | null;
	likes: Record<string, { count: number; liked: boolean }>;
	mcpActiveSource: string;
	mcpCatalogFailures: number;
	mcpInstalled: Set<string>;
	mcpInstallFailures: number;
	mcpInstallGate: { promise: Promise<void>; release: () => void } | null;
	mcpSources: SourceFixture[];
	modelInstalled: Set<string>;
	pluginInstallFailures: number;
	pluginSourceAddFailures: number;
	pluginSources: SourceFixture[];
	preferences: Record<string, string>;
	recommendations: RecommendationFixture;
	refreshFailures: number;
	review: ReviewFixture | null;
	reviewDeleteFailures: number;
	reviewExtraRows: ReviewFixture[];
	reviewListFailures: number;
	reviewWriteFailures: number;
	sandboxDefault: string;
	sandboxListFailures: number;
	sandboxSetFailures: number;
	sandboxSetGate: { promise: Promise<void>; release: () => void } | null;
	skillActiveById: Record<string, boolean>;
	skillActiveSource: string;
	skillCatalogFailures: number;
	skillInstalled: Set<string>;
	skillInstallFailures: number;
	skillPackInstallFailures: number;
	skillPacks: Array<{
		builtin: boolean;
		description: string;
		id: string;
		member_count: number;
		name: string;
	}>;
	skillSourceAddFailures: number;
	skillSources: SourceFixture[];
	skillTargetPreferences: {
		configured: boolean;
		targetIds: string[];
		version: 1;
	};
}

const IDS = {
	model: "fixture/home-gemma",
	recommendation: "fixture/recommended-gemma",
	recommendationSkill: "fixture/recommended-skill",
	recommendationMcp: "fixture/recommended-mcp",
	recommendationAgent: "fixture/recommended-agent",
	recommendationApp: "fixture/recommended-app",
	recommendationPlugin: "fixture/recommended-plugin",
	skill: "fixture/home-skill",
	skillAlpha: "fixture/alpha-skill",
	skillInstalled: "fixture/installed-skill",
	skillCustom: "fixture/custom-skill",
	mcp: "fixture/home-mcp",
	mcpAlpha: "fixture/alpha-mcp",
	mcpAlternate: "fixture/alternate-mcp",
	agent: "fixture/home-agent",
	contextAgent: "fixture/context-agent",
	app: "fixture/home-app",
	plugin: "fixture/home-plugin",
	urlPlugin: "fixture/url-installed-plugin",
	betaPlugin: "fixture/beta-plugin",
	communityPlugin: "fixture/community-plugin",
	utilitiesApp: "fixture/utilities-app",
	engineActive: "llamacpp",
	engineUpdate: "ollama",
	engineNew: "koboldcpp",
	engineUnsupported: "vllm",
	mediaEngine: "sd-cpp",
	mediaNew: "fixture-image-runtime",
	voiceEngine: "pocket-tts",
	whisperEngine: "whispercpp",
	audioEngine: "audiocpp",
} as const;

function modelCard(
	id: string,
	name: string,
	installed = false,
	format: "gguf" | "safetensors" | "mlx" = "gguf"
) {
	return {
		architecture: "fixture-transformer",
		author: "Fixture Lab",
		compatible: true,
		context_length: 8192,
		created_at: "2026-08-01T00:00:00Z",
		downloads: 120,
		format,
		gated: false,
		id,
		installed,
		last_modified: "2026-08-02T00:00:00Z",
		likes: 12,
		name,
		needs_engine: null,
		params: 4_000_000_000,
		pipeline_tag: "text-generation",
		tags: ["chat", "instruct"],
	};
}

function createFixture(): Fixture {
	return {
		auditFailures: 0,
		auditGate: null,
		appCatalogFailures: 0,
		appChannels: {},
		appEnabled: new Set(),
		appsInstalled: new Set(),
		appInstallFailures: 0,
		appUrlInstallFailures: 0,
		agentsAdded: new Set(),
		calls: [],
		installFailures: {},
		installGate: null,
		engineActionFailures: {},
		engineActionGates: {},
		engineCatalogFailures: 0,
		sandboxSetGate: null,
		sandboxListFailures: 0,
		engineActive: IDS.engineActive,
		engineGatewayRefreshed: true,
		engineInstalled: new Set([
			IDS.engineActive,
			IDS.engineUpdate,
			IDS.mediaEngine,
			IDS.voiceEngine,
			IDS.whisperEngine,
			IDS.audioEngine,
			"ryutts",
		]),
		engineInstalledVersions: {
			[IDS.engineActive]: "1.0.0",
			[IDS.engineUpdate]: "0.2.0",
			[IDS.mediaEngine]: "1.0.0",
			[IDS.voiceEngine]: "1.0.0",
			[IDS.whisperEngine]: "1.0.0",
			[IDS.audioEngine]: "1.0.0",
			ryutts: "1.0.0",
		},
		engineRunning: {
			[IDS.mediaEngine]: false,
			[IDS.voiceEngine]: true,
			[IDS.whisperEngine]: true,
			[IDS.audioEngine]: true,
			ryutts: true,
		},
		sandboxDefault: "wasmtime",
		sandboxSetFailures: 0,
		acceleration: {
			selected: "auto",
			resolved: "metal",
			resolvedLabel: "Automatic (Metal)",
			installed: "metal",
			hasGpu: true,
			gpuName: "Fixture Graphics",
			vram: "8 GB",
			options: [
				{
					id: "metal",
					label: "Metal",
					available: true,
					description: "Runs on the fixture graphics device.",
					unavailable_reason: null,
				},
				{
					id: "cuda",
					label: "CUDA",
					available: false,
					description: "Requires an NVIDIA GPU.",
					unavailable_reason: "No NVIDIA GPU was detected.",
				},
			],
		},
		accelerationFailures: 0,
		accelerationGate: null,
		likes: {},
		preferences: {},
		mcpActiveSource: "fixture-mcp-registry",
		mcpCatalogFailures: 0,
		mcpInstallFailures: 0,
		mcpInstallGate: null,
		mcpInstalled: new Set(),
		mcpSources: [
			{
				base_url: "https://mcp.fixture.invalid/registry",
				builtin: true,
				display_name: "Fixture MCP Registry",
				id: "fixture-mcp-registry",
			},
			{
				base_url: "https://mcp-alt.fixture.invalid/registry",
				builtin: false,
				display_name: "Alternate MCP Registry",
				id: "fixture-mcp-alt",
			},
		],
		pluginSources: [
			{
				base_url: null,
				builtin: true,
				display_name: "Ryu Marketplace",
				id: "ryu-catalog",
			},
			{
				base_url: "https://plugins.fixture.invalid/marketplace.json",
				builtin: false,
				display_name: "Fixture Plugin Source",
				id: "fixture-plugin-source",
			},
		],
		pluginSourceAddFailures: 0,
		pluginInstallFailures: 0,
		modelInstalled: new Set(),
		recommendations: {
			cadence: "weekly",
			enabled: true,
			hidden: false,
			items: [
				{
					description: "A model matched to this node's catalog.",
					id: IDS.recommendation,
					installed: false,
					kind: "model",
					name: "For You Gemma",
					reason: "Fits the local fixture device.",
				},
				{
					description: "A local skill recommendation.",
					id: IDS.recommendationSkill,
					installed: false,
					kind: "skill",
					name: "For You Skill",
					reason: "Useful with this catalog.",
				},
				{
					description: "A local MCP recommendation.",
					id: IDS.recommendationMcp,
					installed: false,
					kind: "mcp",
					name: "For You MCP",
					reason: "Useful with this catalog.",
				},
				{
					description: "A local agent recommendation.",
					id: IDS.recommendationAgent,
					installed: false,
					kind: "agent",
					name: "For You Agent",
					reason: "Useful with this catalog.",
				},
				{
					description: "A local app recommendation.",
					id: IDS.recommendationApp,
					installed: false,
					kind: "app",
					name: "For You App",
					reason: "Useful with this catalog.",
				},
				{
					description: "A local plugin recommendation.",
					id: IDS.recommendationPlugin,
					installed: false,
					kind: "plugin",
					name: "For You Plugin",
					reason: "Useful with this catalog.",
				},
			],
		},
		refreshFailures: 0,
		review: null,
		reviewDeleteFailures: 0,
		reviewExtraRows: [],
		reviewListFailures: 0,
		reviewWriteFailures: 0,
		skillActiveById: { "fixture/installed-skill": true },
		skillActiveSource: "fixture-skill-registry",
		skillCatalogFailures: 0,
		skillInstallFailures: 0,
		skillSourceAddFailures: 0,
		skillPackInstallFailures: 0,
		skillPacks: [
			{
				builtin: true,
				description: "A local fixture pack for productivity tasks.",
				id: "fixture/productivity-pack",
				member_count: 2,
				name: "Fixture Productivity Pack",
			},
			{
				builtin: true,
				description: "A second local fixture pack for focus tasks.",
				id: "fixture/research-pack",
				member_count: 1,
				name: "Fixture Research Pack",
			},
		],
		skillInstalled: new Set(["fixture/installed-skill"]),
		skillTargetPreferences: { configured: false, targetIds: [], version: 1 },
		skillSources: [
			{
				base_url: "https://skills.fixture.invalid",
				builtin: true,
				display_name: "Fixture Skills Registry",
				id: "fixture-skill-registry",
			},
			{
				base_url: "https://custom-skills.fixture.invalid/marketplace.json",
				builtin: false,
				display_name: "Fixture Custom Marketplace",
				id: "fixture-custom-skills",
			},
		],
	};
}

async function json<FixturePayload>(
	route: Route,
	status: number,
	value: FixturePayload
) {
	await route.fulfill({
		body: JSON.stringify(value),
		contentType: "application/json",
		status,
	});
}

async function requestBody(route: Route): Promise<StoreProofJson> {
	try {
		return storeProofJsonSchema.parse(route.request().postDataJSON());
	} catch {
		return undefined;
	}
}

function appCatalogEntry(
	id: string,
	name: string,
	type: "app" | "plugin",
	source: string,
	overrides: Partial<CatalogEntry & Pick<AppPresentation, "stability">> = {}
) {
	return {
		built_in: source === "built-in",
		category: type === "app" ? "Productivity" : "Developer tools",
		catalog_source_id:
			source === "built-in" ? "ryu-catalog" : "fixture-plugin-source",
		catalog_source_name:
			source === "built-in" ? "Ryu Marketplace" : "Fixture Plugin Source",
		description: `${name} local fixture`,
		stability: "stable",
		id,
		kinds: type === "app" ? ["companion"] : ["tool"],
		name,
		permission_grants:
			id === IDS.app ? ["net.fetch"] : id === IDS.plugin ? ["tools:read"] : [],
		source,
		tags: ["fixture"],
		type,
		version: "1.0.0",
		...overrides,
	};
}

function appLifecycle(fixture: Fixture, id: string) {
	return {
		approved_grants: [],
		built_in: id === IDS.app,
		channel: fixture.appChannels[id] ?? null,
		description: "Installed local fixture.",
		enabled: fixture.appEnabled.has(id),
		id,
		installed: true,
		installed_version:
			fixture.appChannels[id] === "beta" ? "1.1.0-beta.1" : "1.0.0",
		local_only: false,
		name:
			id === IDS.app
				? "Fixture Home App"
				: id === IDS.plugin
					? "Fixture Home Plugin"
					: "URL Installed Plugin",
		permission_grants:
			id === IDS.app ? ["net.fetch"] : id === IDS.plugin ? ["tools:read"] : [],
		runnables: [{ id: "open", kind: "command", name: "Open" }],
		sidecar_name: null,
		version: "1.0.0",
		windows_first: false,
	};
}

function engineCatalogItems(fixture: Fixture) {
	const catalog: EngineCatalogFixture[] = [
		{
			category: "provider",
			deprecated: false,
			description: "The resident local text engine fixture.",
			display_name: "llama.cpp",
			latest_version: "1.0.0",
			name: IDS.engineActive,
			platforms: ["macos"],
			supported: true,
			update_available: false,
		},
		{
			category: "provider",
			deprecated: false,
			description: "A second installed text engine fixture.",
			display_name: "Ollama Fixture",
			latest_version: "0.3.0",
			name: IDS.engineUpdate,
			platforms: [],
			supported: true,
			update_available: true,
		},
		{
			category: "provider",
			deprecated: false,
			description: "A text engine ready to add.",
			display_name: "KoboldCPP Fixture",
			latest_version: "1.0.0",
			name: IDS.engineNew,
			platforms: [],
			supported: true,
			update_available: false,
		},
		{
			category: "provider",
			deprecated: false,
			description: "An engine that this node cannot run.",
			display_name: "VLLM Unsupported Fixture",
			latest_version: "1.0.0",
			name: IDS.engineUnsupported,
			platforms: ["linux"],
			supported: false,
			update_available: false,
		},
		...[
			{ name: "sglang", displayName: "SGLang Fixture" },
			{ name: "mlx", displayName: "MLX Text Fixture" },
			{ name: "mlx-vlm", displayName: "MLX VLM Fixture" },
			{ name: "mlx-serve", displayName: "MLX Serve Fixture" },
			{ name: "omlx", displayName: "oMLX Fixture" },
			{ name: "lemonade", displayName: "Lemonade Fixture" },
			{ name: "llama-swap", displayName: "llama-swap Fixture" },
			{ name: "freetoken", displayName: "FreeToken Fixture" },
			{
				name: "docker-model-runner",
				displayName: "Docker Model Runner Fixture",
			},
			{ name: "apfel", displayName: "Apple Intelligence Fixture" },
			{ name: "mesh-llm", displayName: "Mesh LLM Fixture" },
		].map(({ name, displayName }) => ({
			category: "provider" as const,
			deprecated: false,
			description: `The ${displayName} chat engine fixture.`,
			display_name: displayName,
			latest_version: "1.0.0",
			name,
			platforms: [],
			supported: true,
			update_available: false,
		})),
		{
			category: "media",
			deprecated: false,
			description: "An image sidecar ready to add.",
			display_name: "Image Sidecar Candidate",
			latest_version: "1.0.0",
			name: IDS.mediaNew,
			platforms: [],
			supported: true,
			update_available: false,
		},
		{
			category: "media",
			deprecated: false,
			description: "An image and video engine fixture.",
			display_name: "Stable Diffusion CPP Fixture",
			latest_version: "1.0.0",
			name: IDS.mediaEngine,
			platforms: [],
			supported: true,
			update_available: false,
		},
		{
			category: "voice",
			deprecated: false,
			description: "A speech recognition engine fixture.",
			display_name: "Pocket TTS Fixture",
			latest_version: "1.0.0",
			name: IDS.voiceEngine,
			platforms: [],
			supported: true,
			update_available: false,
		},
		{
			category: "voice",
			deprecated: false,
			description: "Whisper.cpp recognition fixture.",
			display_name: "Whisper.cpp Fixture",
			latest_version: "1.0.0",
			name: IDS.whisperEngine,
			platforms: [],
			supported: true,
			update_available: false,
		},
		{
			category: "voice",
			deprecated: false,
			description: "Audio.cpp recognition and generation fixture.",
			display_name: "Audio.cpp Fixture",
			latest_version: "1.0.0",
			name: IDS.audioEngine,
			platforms: [],
			supported: true,
			update_available: false,
		},
		{
			category: "voice",
			deprecated: false,
			description: "The multi-engine local speech generation fixture.",
			display_name: "Ryu Audio Fixture",
			latest_version: "1.0.0",
			name: "ryutts",
			platforms: [],
			supported: true,
			update_available: false,
		},
	];
	return catalog.map((engine) => {
		const installed = fixture.engineInstalled.has(engine.name);
		const installedVersion =
			fixture.engineInstalledVersions[engine.name] ?? null;
		return {
			...engine,
			install_state: installed ? "installed" : "not_installed",
			installed_version: installedVersion,
			// Core serializes every registry entry's `recommended` flag, and the
			// native catalog contract rejects a response item without it.
			recommended: false,
			update_available:
				installed &&
				engine.update_available &&
				installedVersion !== engine.latest_version,
		};
	});
}

function skillFixtureCards(fixture: Fixture) {
	return [
		{
			catalog_source_id: "fixture-skill-registry",
			catalog_source_name: "Fixture Skills Registry",
			description: "A local skill for the Home shelf.",
			id: IDS.skill,
			installed: fixture.skillInstalled.has(IDS.skill),
			installs: 22,
			name: "Home Skill Fixture",
			slug: "home-skill-fixture",
			source: "Fixture Skills Registry",
		},
		{
			catalog_source_id: "fixture-skill-registry",
			catalog_source_name: "Fixture Skills Registry",
			description: "An alpha skill used for search and sort proof.",
			id: IDS.skillAlpha,
			installed: fixture.skillInstalled.has(IDS.skillAlpha),
			installs: 100,
			name: "alpha assistant",
			slug: "alpha-assistant",
			source: "Fixture Skills Registry",
		},
		{
			catalog_source_id: "fixture-skill-registry",
			catalog_source_name: "Fixture Skills Registry",
			description: "An installed skill with a persisted active state.",
			id: IDS.skillInstalled,
			installed: fixture.skillInstalled.has(IDS.skillInstalled),
			installs: 50,
			name: "Installed Skill",
			slug: "installed-skill",
			source: "Fixture Skills Registry",
		},
		{
			catalog_source_id: "fixture-custom-skills",
			catalog_source_name: "Fixture Custom Marketplace",
			description: "A skill from the custom local marketplace.",
			id: IDS.skillCustom,
			installed: fixture.skillInstalled.has(IDS.skillCustom),
			installs: 70,
			name: "custom helper",
			slug: "custom-helper",
			source: "Fixture Custom Marketplace",
		},
	];
}

function mcpFixtureCards(fixture: Fixture, source: string) {
	const cards =
		source === "fixture-mcp-alt"
			? [
					{
						description: "An MCP server from the alternate local registry.",
						id: IDS.mcpAlternate,
						installed: fixture.mcpInstalled.has(IDS.mcpAlternate),
						name: "Alternate MCP Fixture",
						transports: ["streamable-http"],
						version: "2.0.0",
					},
				]
			: [
					{
						description: "A local MCP fixture.",
						id: IDS.mcp,
						installed: fixture.mcpInstalled.has(IDS.mcp),
						name: "Home MCP Fixture",
						transports: ["stdio"],
						version: "1.0.0",
					},
					{
						description: "A searchable MCP catalog fixture.",
						id: IDS.mcpAlpha,
						installed: fixture.mcpInstalled.has(IDS.mcpAlpha),
						name: "Alpha MCP Fixture",
						transports: ["stdio"],
						version: "1.1.0",
					},
				];
	return cards;
}

async function installLocalFixture(
	page: Page,
	apiOrigin = API_ORIGIN,
	strictEngines = false
): Promise<Fixture> {
	const fixture = createFixture();
	const diagnostic: EngineFixtureDiagnostics = {
		pageErrors: [],
		unknown: [],
		fixture,
	};
	if (strictEngines) {
		engineDiagnostics.set(page, diagnostic);
		page.on("pageerror", (error) => diagnostic.pageErrors.push(error.message));
	}
	await page.route(
		strictEngines
			? (url) => url.pathname.startsWith("/api/")
			: `${apiOrigin}/api/**`,
		async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			const method = request.method();
			const body = await requestBody(route);
			fixture.calls.push({
				body,
				method,
				path: url.pathname,
				search: url.search,
			});
			if (strictEngines) {
				if (url.origin !== apiOrigin) {
					diagnostic.unknown.push({
						method,
						path: `${url.origin}${url.pathname}`,
						search: url.search,
						body,
					});
					return json(route, 501, {
						error: "Engines fixture called an unexpected API origin",
					});
				}
				expect(
					request.headers().authorization,
					`${method} ${url.pathname} node authorization`
				).toBe("Bearer fixture-node-token");
				if (method === "GET") {
					expect(body).toBeNull();
				}
				const lifecycle = url.pathname.match(
					/^\/api\/(?:setup|sidecar)\/([^/]+)\/(install|uninstall|start|stop)$/
				);
				if (lifecycle) {
					expect(method).toBe("POST");
					expect(
						engineCatalogItems(fixture).map((item) => item.name)
					).toContain(decodeURIComponent(lifecycle[1] ?? ""));
					expect(body).toBeNull();
					expect(["", "?force=true"]).toContain(url.search);
					if (url.search) {
						expect(lifecycle[2]).toBe("install");
					}
				}
				if (method === "POST" && url.pathname === "/api/engine/active") {
					expect(body).toEqual({ name: expect.any(String) });
					expect(
						engineCatalogItems(fixture).map((item) => item.name)
					).toContain(storeNameRequestSchema.parse(body).name);
				}
				if (method === "POST" && url.pathname === "/api/sandbox/backend") {
					expect(body).toEqual({
						name: expect.stringMatching(/^(wasmtime|docker|opensandbox)$/),
					});
				}
				if (
					method === "POST" &&
					url.pathname === "/api/engine/llamacpp/acceleration"
				) {
					expect(body).toEqual({ variant: expect.any(String) });
					expect([
						"auto",
						...fixture.acceleration.options.map((option) => option.id),
					]).toContain(storeVariantRequestSchema.parse(body).variant);
				}
			}
			if (
				strictEngines &&
				method === "GET" &&
				url.pathname === "/api/plugins/contributions"
			) {
				expect(url.search).toBe("");
				return json(route, 200, EMPTY_ENGINE_CONTRIBUTIONS);
			}
			if (
				strictEngines &&
				method === "GET" &&
				url.pathname === "/api/gateway/org-features"
			) {
				expect(url.search).toBe("");
				// An organization-free node: Core reports no feature policy, so the
				// Engines catalog and update controls stay available.
				return json(route, 200, {
					available: true,
					features: {},
					managed: false,
				});
			}
			const preferencePath = url.pathname.match(
				/^\/api\/preferences\/([^/]+)$/
			);
			if (preferencePath) {
				const key = decodeURIComponent(preferencePath[1] ?? "");
				if (method === "GET") {
					return json(route, 200, {
						key,
						value: fixture.preferences[key] ?? null,
					});
				}
				if (method === "PUT") {
					if (strictEngines) {
						expect(body).toEqual({ value: expect.any(String) });
					}
					fixture.preferences[key] =
						storePreferenceRequestSchema.parse(body).value;
					return json(route, 200, { key, value: fixture.preferences[key] });
				}
			}

			if (url.pathname === "/api/catalog/sources/select" && method === "POST") {
				const selection = storeSourceSelectionSchema.parse(body);
				if (selection.kind === "mcp") {
					fixture.mcpActiveSource = selection.id;
				}
				return json(route, 200, { ok: true });
			}
			if (url.pathname === "/api/catalog/sources") {
				const kind = url.searchParams.get("kind");
				if (method === "GET") {
					const sources =
						kind === "mcp"
							? fixture.mcpSources
							: kind === "plugin"
								? fixture.pluginSources
								: fixture.skillSources;
					const active =
						kind === "mcp"
							? fixture.mcpActiveSource
							: fixture.skillActiveSource;
					return json(route, 200, { active, sources });
				}
				const mutation = storeSourceMutationSchema.parse(body);
				const sourceKind = mutation.kind ?? kind;
				if (method === "POST" && sourceKind !== "mcp") {
					const pluginSource = sourceKind === "plugin";
					const failures = pluginSource
						? fixture.pluginSourceAddFailures
						: fixture.skillSourceAddFailures;
					if (failures > 0) {
						if (pluginSource) {
							fixture.pluginSourceAddFailures -= 1;
						} else {
							fixture.skillSourceAddFailures -= 1;
						}
						return json(route, pluginSource ? 200 : 503, {
							ok: false,
							error: "Fixture source add failed",
						});
					}
					const source = {
						base_url: mutation.base_url ?? null,
						builtin: false,
						display_name: mutation.display_name ?? mutation.id,
						id: mutation.id,
					};
					if (pluginSource) {
						fixture.pluginSources.push(source);
					} else {
						fixture.skillSources.push(source);
					}
					return json(route, 200, { ok: true });
				}
				if (method === "DELETE" && mutation.kind === "skill") {
					fixture.skillSources = fixture.skillSources.filter(
						(source) => source.id !== mutation.id
					);
					return json(route, 200, { ok: true });
				}
			}
			if (
				url.pathname === "/api/catalog/sources/reorder" &&
				method === "POST"
			) {
				const mutation = storeSourceReorderSchema.parse(body);
				if (mutation.kind === "skill") {
					const index = fixture.skillSources.findIndex(
						(source) => source.id === mutation.id
					);
					const targetIndex =
						mutation.direction === "up" ? index - 1 : index + 1;
					if (
						index >= 0 &&
						targetIndex >= 0 &&
						targetIndex < fixture.skillSources.length
					) {
						const [source] = fixture.skillSources.splice(index, 1);
						if (source) {
							fixture.skillSources.splice(targetIndex, 0, source);
						}
					}
				}
				return json(route, 200, { ok: true });
			}
			if (url.pathname === "/api/catalog" && method === "GET") {
				if (fixture.engineCatalogFailures > 0) {
					fixture.engineCatalogFailures -= 1;
					return json(route, 503, {
						error: "Fixture engine catalog unavailable",
					});
				}
				return json(route, 200, { sidecars: engineCatalogItems(fixture) });
			}
			if (url.pathname === "/api/engine/active") {
				if (method === "GET") {
					return json(route, 200, {
						active: fixture.engineActive,
						available: [IDS.engineActive, IDS.engineUpdate],
						llamacpp_variant: fixture.acceleration.installed,
						running: true,
					});
				}
				if (method === "POST") {
					const next = storeNameRequestSchema.parse(body).name;
					if ((fixture.engineActionFailures[`${next}:activate`] ?? 0) > 0) {
						fixture.engineActionFailures[`${next}:activate`] -= 1;
						return json(route, 503, {
							error: "Fixture engine activation failed",
						});
					}
					if (fixture.engineActionGates[`${next}:activate`]) {
						const gate = fixture.engineActionGates[`${next}:activate`];
						delete fixture.engineActionGates[`${next}:activate`];
						await gate?.promise;
					}
					const stopped = fixture.engineActive;
					fixture.engineActive = next;
					return json(route, 200, {
						active: next,
						gateway_refreshed: fixture.engineGatewayRefreshed,
						running: true,
						stopped,
						success: true,
						unchanged: stopped === next,
					});
				}
			}
			if (url.pathname === "/api/sidecar/status" && method === "GET") {
				return json(route, 200, {
					sidecars: Object.entries(fixture.engineRunning).map(
						([name, running]) => ({
							name,
							running,
						})
					),
				});
			}
			const engineLifecycle = url.pathname.match(
				/^\/api\/setup\/([^/]+)\/(install|uninstall)$/
			);
			if (engineLifecycle && method === "POST") {
				const name = decodeURIComponent(engineLifecycle[1] ?? "");
				const action = engineLifecycle[2] ?? "";
				const failureKey = `${name}:${action}`;
				if ((fixture.engineActionFailures[failureKey] ?? 0) > 0) {
					fixture.engineActionFailures[failureKey] -= 1;
					return json(route, 503, { error: `Fixture ${action} failed` });
				}
				const gate = fixture.engineActionGates[failureKey];
				if (gate) {
					delete fixture.engineActionGates[failureKey];
					await gate.promise;
				}
				if (action === "install") {
					fixture.engineInstalled.add(name);
					fixture.engineInstalledVersions[name] =
						name === IDS.engineUpdate ? "0.3.0" : "1.0.0";
					// Core's accepted-install reply: the force flag it honored and the
					// background-install notice the native setup contract requires.
					return json(route, 200, {
						success: true,
						forced: url.searchParams.get("force") === "true",
						message: `Sidecar '${name}' installation started in background`,
					});
				}
				fixture.engineInstalled.delete(name);
				delete fixture.engineInstalledVersions[name];
				return json(route, 200, {
					success: true,
					message: `Sidecar '${name}' uninstalled`,
				});
			}
			const sidecarControl = url.pathname.match(
				/^\/api\/sidecar\/([^/]+)\/(start|stop)$/
			);
			if (sidecarControl && method === "POST") {
				const name = decodeURIComponent(sidecarControl[1] ?? "");
				const action = sidecarControl[2] ?? "";
				const failureKey = `${name}:${action}`;
				if ((fixture.engineActionFailures[failureKey] ?? 0) > 0) {
					fixture.engineActionFailures[failureKey] -= 1;
					return json(route, 503, { error: `Fixture ${action} failed` });
				}
				const gate = fixture.engineActionGates[failureKey];
				if (gate) {
					delete fixture.engineActionGates[failureKey];
					await gate.promise;
				}
				fixture.engineRunning[name] = action === "start";
				return json(route, 200, { success: true });
			}
			if (url.pathname === "/api/sandbox/backend") {
				if (method === "GET") {
					if (fixture.sandboxListFailures > 0) {
						fixture.sandboxListFailures -= 1;
						return json(route, 503, {
							error: "Fixture sandbox list unavailable",
						});
					}
					return json(route, 200, {
						active: fixture.sandboxDefault,
						available: [
							{
								detected: true,
								display_name: "WasmTime Fixture",
								name: "wasmtime",
								supported: true,
							},
							{
								detected: false,
								display_name: "Docker Fixture",
								name: "docker",
								supported: true,
							},
							{
								detected: false,
								display_name: "OpenSandbox Fixture",
								name: "opensandbox",
								supported: false,
							},
						],
					});
				}
				if (method === "POST") {
					if (fixture.sandboxSetFailures > 0) {
						fixture.sandboxSetFailures -= 1;
						return json(route, 503, {
							error: "Fixture sandbox selection failed",
						});
					}
					if (fixture.sandboxSetGate) {
						const gate = fixture.sandboxSetGate;
						fixture.sandboxSetGate = null;
						await gate.promise;
					}
					fixture.sandboxDefault = storeNameRequestSchema.parse(body).name;
					return json(route, 200, {
						active: fixture.sandboxDefault,
						success: true,
					});
				}
			}
			if (url.pathname === "/api/engine/llamacpp/acceleration") {
				if (method === "GET") {
					return json(route, 200, {
						selected: fixture.acceleration.selected,
						resolved: fixture.acceleration.resolved,
						resolved_label: fixture.acceleration.resolvedLabel,
						installed: fixture.acceleration.installed,
						has_gpu: fixture.acceleration.hasGpu,
						gpu_name: fixture.acceleration.gpuName,
						vram: fixture.acceleration.vram,
						options: fixture.acceleration.options.map((option) => ({
							...option,
							unavailable_reason: option.unavailable_reason,
						})),
					});
				}
				if (method === "POST") {
					if (fixture.accelerationFailures > 0) {
						fixture.accelerationFailures -= 1;
						return json(route, 503, {
							error: "Fixture acceleration switch failed",
						});
					}
					if (fixture.accelerationGate) {
						const gate = fixture.accelerationGate;
						fixture.accelerationGate = null;
						await gate.promise;
					}
					fixture.acceleration.selected =
						storeVariantRequestSchema.parse(body).variant;
					fixture.acceleration.resolved = fixture.acceleration.selected;
					fixture.acceleration.resolvedLabel =
						fixture.acceleration.selected === "auto"
							? "Automatic (Metal)"
							: fixture.acceleration.selected;
					return json(route, 200, { success: true });
				}
			}

			if (url.pathname === "/api/voice/tts-engines" && method === "GET") {
				return json(route, 200, {
					data: [
						{
							default_voice: "",
							description: "The bundled OuteTTS engine fixture.",
							display_name: "OuteTTS Fixture",
							id: "outetts",
							installed: true,
							languages: ["en"],
							loaded: false,
							sample_rate: 24_000,
							size_mb: 0,
							supports_cloning: false,
							voices: [],
						},
						{
							default_voice: "af_heart",
							description: "The Kokoro speech generation fixture.",
							display_name: "Kokoro Fixture",
							id: "kokoro",
							installed: true,
							languages: ["en"],
							loaded: true,
							sample_rate: 24_000,
							size_mb: 82,
							supports_cloning: false,
							voices: ["af_heart", "af_bella"],
						},
						{
							default_voice: "alba",
							description: "The cloning-capable Pocket speech fixture.",
							display_name: "Pocket Fixture",
							id: "pocket",
							installed: true,
							languages: ["en"],
							loaded: true,
							sample_rate: 24_000,
							size_mb: 100,
							supports_cloning: true,
							voices: ["alba"],
						},
					],
				});
			}
			if (url.pathname === "/api/voice/tts-models" && method === "GET") {
				return json(route, 200, { data: [] });
			}
			if (url.pathname === "/api/voice/speak" && method === "POST") {
				return route.fulfill({
					status: 200,
					contentType: "audio/wav",
					body: "",
				});
			}
			if (url.pathname === "/api/marketplace/recommendations") {
				if (method === "POST" && url.searchParams.get("refresh") === "true") {
					if (fixture.refreshFailures > 0) {
						fixture.refreshFailures -= 1;
						return json(route, 503, { error: "Local refresh fixture failure" });
					}
					fixture.recommendations.items = [
						{
							...fixture.recommendations.items[0],
							name: "Refreshed For You Gemma",
						},
					];
					return json(route, 200, { success: true });
				}
				if (method === "GET") {
					return json(route, 200, fixture.recommendations);
				}
			}
			if (
				url.pathname === "/api/marketplace/recommendations/preference" &&
				method === "PUT"
			) {
				const patch = storeRecommendationPreferenceSchema.parse(body);
				fixture.recommendations.hidden = patch.hidden === true;
				return json(route, 200, { success: true });
			}
			if (url.pathname === "/api/gateway/config" && method === "PUT") {
				const policy = gatewayMarketplaceUpdateObservation(body);
				if (policy.cadence) {
					fixture.recommendations.cadence = policy.cadence;
				}
				return json(route, 200, { ok: true });
			}
			if (
				url.pathname === "/api/marketplace/likes/batch" &&
				method === "POST"
			) {
				const namespaces = storeLikesBatchSchema.parse(body).namespaces ?? [];
				return json(route, 200, {
					items: namespaces.map((namespace) => {
						let like = fixture.likes[namespace];
						if (!like) {
							like = { count: 2, liked: false };
							fixture.likes[namespace] = like;
						}
						return { ...like, namespace };
					}),
				});
			}
			if (url.pathname === "/api/marketplace/likes") {
				const namespace = storeLikeRequestSchema.parse(body).namespace;
				let like = fixture.likes[namespace];
				if (!like) {
					like = { count: 2, liked: false };
					fixture.likes[namespace] = like;
				}
				if (method === "POST") {
					like.count += 1;
					like.liked = true;
				} else if (method === "DELETE") {
					like.count = Math.max(0, like.count - 1);
					like.liked = false;
				}
				return json(route, 200, { ...like, namespace });
			}
			if (url.pathname === "/api/marketplace/reviews") {
				if (method === "GET") {
					if (fixture.reviewListFailures > 0) {
						fixture.reviewListFailures -= 1;
						return json(route, 503, {
							error: "Fixture review list unavailable",
						});
					}
					const cursor = url.searchParams.get("cursor");
					const pageReviews = cursor
						? fixture.reviewExtraRows.slice(20)
						: [
								...(fixture.review ? [fixture.review] : []),
								...fixture.reviewExtraRows.slice(0, 20),
							];
					return json(route, 200, {
						nextCursor:
							!cursor && fixture.reviewExtraRows.length > 20
								? "fixture-review-next"
								: null,
						ratingAverage:
							pageReviews[0]?.rating ?? fixture.review?.rating ?? 0,
						ratingCount:
							fixture.reviewExtraRows.length + (fixture.review ? 1 : 0),
						reviews: pageReviews,
					});
				}
				if (method === "POST") {
					if (fixture.reviewWriteFailures > 0) {
						fixture.reviewWriteFailures -= 1;
						return json(route, 503, {
							error: "Fixture review write unavailable",
						});
					}
					const input = storeReviewRequestSchema.parse(body);
					fixture.review = {
						body: input.body ?? null,
						createdAt: "2026-08-20T00:00:00Z",
						id: "fixture-review",
						mine: true,
						rating: input.rating,
						title: input.title ?? null,
						userName: "Fixture Reviewer",
						verifiedPurchase: false,
					};
					return json(route, 200, {
						ratingAverage: input.rating,
						ratingCount: 1,
					});
				}
				if (method === "DELETE") {
					if (fixture.reviewDeleteFailures > 0) {
						fixture.reviewDeleteFailures -= 1;
						return json(route, 503, {
							error: "Fixture review delete unavailable",
						});
					}
					fixture.review = null;
					return json(route, 200, { success: true });
				}
			}

			if (url.pathname === "/api/models/catalog") {
				const query = url.searchParams.get("query")?.toLowerCase() ?? "";
				const all = [
					modelCard(
						IDS.model,
						"Home GGUF Candidate",
						fixture.modelInstalled.has(IDS.model)
					),
					modelCard(
						"fixture/home-safetensors",
						"Home Safetensors Snapshot",
						fixture.modelInstalled.has("fixture/home-safetensors"),
						"safetensors"
					),
					modelCard(
						"fixture/home-mlx",
						"Home MLX Snapshot",
						fixture.modelInstalled.has("fixture/home-mlx"),
						"mlx"
					),
					modelCard(
						IDS.recommendation,
						"For You Gemma",
						fixture.modelInstalled.has(IDS.recommendation)
					),
				];
				const models = query
					? query.includes("heading needle")
						? [modelCard("fixture/heading-match", "Heading Needle Model")]
						: []
					: all;
				return json(route, 200, {
					models,
					next_cursor: null,
					total: models.length,
				});
			}
			if (url.pathname === "/api/models/catalog/detail" && method === "GET") {
				const id = url.searchParams.get("id") ?? IDS.model;
				const name =
					id === IDS.recommendation ? "For You Gemma" : "Home GGUF Candidate";
				return json(route, 200, {
					card: modelCard(id, name, fixture.modelInstalled.has(id)),
					device: {
						gpu_name: "Fixture GPU",
						os: "linux",
						ram_human: "16 GB",
						total_ram_bytes: 16_000_000_000,
						unified_memory: false,
						vram_bytes: 8_000_000_000,
						vram_human: "8 GB",
					},
					files: [
						{
							filename: "home-gemma-Q4_K_M.gguf",
							fit: "great",
							fit_label: "Fits your device",
							quant: "Q4_K_M",
							size_bytes: 2_400_000_000,
							size_human: "2.4 GB",
							url: "https://fixture.invalid/home-gemma-q4.gguf",
						},
						{
							filename: "home-gemma-Q8_0.gguf",
							fit: "partial",
							fit_label: "Fits with reduced context",
							quant: "Q8_0",
							size_bytes: 4_800_000_000,
							size_human: "4.8 GB",
							url: "https://fixture.invalid/home-gemma-q8.gguf",
						},
					],
					format: "gguf",
					readme:
						id === IDS.recommendation
							? "Recommendation selected fixture detail."
							: null,
					repo_fit: "",
					repo_fit_label: "",
				});
			}
			if (url.pathname === "/api/models/catalog/install" && method === "POST") {
				const install = storeModelInstallSchema.parse(body);
				const gate = fixture.installGate;
				if (gate) {
					fixture.installGate = null;
					await gate.promise;
				}
				if (fixture.installFailures[url.pathname] > 0) {
					fixture.installFailures[url.pathname] -= 1;
					return json(route, 503, { error: "Local install fixture failure" });
				}
				if (install.format === "gguf" && !install.file) {
					return json(route, 422, { error: "A GGUF filename is required" });
				}
				fixture.modelInstalled.add(install.id);
				return json(route, 200, {
					result: {
						filename: install.file ?? `${install.id}.snapshot`,
						path: `/fixture/models/${install.id}`,
						repo_id: install.id,
					},
					success: true,
				});
			}

			if (url.pathname === "/api/skills" && method === "GET") {
				const cards = skillFixtureCards(fixture);
				return json(route, 200, {
					skills: cards
						.filter((card) => fixture.skillInstalled.has(card.id))
						.map((card) => ({
							allowed_tools: [],
							description: card.description,
							enabled: fixture.skillActiveById[card.id] ?? false,
							id: card.id,
							name: card.name,
						})),
				});
			}
			if (url.pathname === "/api/skills/targets" && method === "GET") {
				return json(route, 200, {
					droppedTargetIds: [],
					preferences: fixture.skillTargetPreferences,
					targets: [
						{
							detected: true,
							featured: true,
							globalSkillsDir: "/fixture/agents/code/skills",
							id: "fixture-code-agent",
							name: "Fixture Code Agent",
							projectSkillsDir: "/fixture/project/.agents/skills",
							resolvedGlobalPath: "/fixture/agents/code/skills",
							selectable: true,
							unavailableReason: null,
						},
						{
							detected: false,
							featured: false,
							globalSkillsDir: null,
							id: "fixture-unavailable-agent",
							name: "Unavailable Fixture Agent",
							projectSkillsDir: "/fixture/project/.agents/skills",
							resolvedGlobalPath: null,
							selectable: false,
							unavailableReason: "The agent is not installed.",
						},
					],
					warning: null,
				});
			}
			if (url.pathname.endsWith("/distribute") && method === "POST") {
				const distribution = storeSkillDistributionSchema.parse(body);
				const skillId = decodeURIComponent(
					url.pathname.split("/").at(-2) ?? ""
				);
				if (distribution.rememberTargetIds) {
					fixture.skillTargetPreferences = {
						configured: true,
						targetIds: distribution.targetIds,
						version: 1,
					};
				}
				return json(route, 200, {
					distribution: {
						skillId,
						targets: distribution.targetIds.map((targetId) => ({
							message: null,
							path: `/fixture/agents/${targetId}/skills/${skillId}`,
							status: "copied",
							targetId,
						})),
					},
					success: true,
				});
			}
			if (url.pathname === "/api/skills/activate" && method === "POST") {
				const activation = storeSkillActivationSchema.parse(body);
				fixture.skillActiveById[activation.id] = activation.active;
				return json(route, 200, { success: true });
			}
			if (url.pathname === "/api/skills/catalog" && method === "GET") {
				const searchQuery = url.searchParams.get("query")?.toLowerCase() ?? "";
				const source = url.searchParams.get("source") ?? "all";
				const installedOnly = url.searchParams.get("installed_only") === "true";
				const limit = url.searchParams.get("limit");
				if (limit === "120" && fixture.skillCatalogFailures > 0) {
					fixture.skillCatalogFailures -= 1;
					return json(route, 503, {
						error: "Fixture skills catalog is unavailable",
					});
				}
				let skills = skillFixtureCards(fixture);
				if (limit === "12" && !searchQuery) {
					skills = skills.filter((card) => card.id === IDS.skill);
				}
				if (source !== "all") {
					skills = skills.filter((card) => card.catalog_source_id === source);
				}
				if (searchQuery) {
					skills = skills.filter((card) =>
						[card.id, card.name, card.description, card.source].some((field) =>
							field.toLowerCase().includes(searchQuery)
						)
					);
				}
				if (installedOnly) {
					skills = skills.filter((card) => fixture.skillInstalled.has(card.id));
				}
				return json(route, 200, {
					next_cursor: null,
					skills,
					total: skills.length,
				});
			}
			if (url.pathname === "/api/skills/catalog/detail" && method === "GET") {
				const id = url.searchParams.get("id") ?? IDS.skill;
				const card = skillFixtureCards(fixture).find(
					(skill) => skill.id === id
				);
				return json(route, 200, {
					card: card ?? skillFixtureCards(fixture)[0],
					description: card?.description ?? "Selected skill fixture detail.",
					files: [
						{ contents: "Local fixture instructions.", path: "SKILL.md" },
						{
							contents: "Reference content for selection proof.",
							path: "references/DETAIL.md",
						},
					],
					metadata: {
						installs: "22",
						repository_url: "https://fixture.invalid/skills",
					},
					readme: "Selected skill detail from the local fixture.",
					url: "https://fixture.invalid/home-skill",
				});
			}
			if (url.pathname === "/api/skills/catalog/install" && method === "POST") {
				const install = storeSkillInstallSchema.parse(body);
				if (fixture.skillInstallFailures > 0) {
					fixture.skillInstallFailures -= 1;
					return json(route, 503, { error: "Fixture skill install failed" });
				}
				fixture.skillInstalled.add(install.id);
				fixture.skillActiveById[install.id] = false;
				return json(route, 200, {
					result: {
						path: `/fixture/skills/${install.id}`,
						slug: "home-skill-fixture",
					},
					success: true,
				});
			}
			if (url.pathname === "/api/skills/packs" && method === "GET") {
				return json(route, 200, { packs: fixture.skillPacks });
			}
			if (url.pathname === "/api/skills/packs/detail" && method === "GET") {
				const id = url.searchParams.get("id") ?? "fixture/productivity-pack";
				const members =
					id === "fixture/research-pack"
						? [
								{
									description: "An installed active skill.",
									id: IDS.skillInstalled,
									installed: fixture.skillInstalled.has(IDS.skillInstalled),
									name: "Installed Skill",
								},
							]
						: [
								{
									description: "An alpha skill used for search and sort proof.",
									id: IDS.skillAlpha,
									installed: fixture.skillInstalled.has(IDS.skillAlpha),
									name: "alpha assistant",
								},
								{
									description: "A custom-source skill.",
									id: IDS.skillCustom,
									installed: fixture.skillInstalled.has(IDS.skillCustom),
									name: "custom helper",
								},
							];
				return json(route, 200, {
					builtin: true,
					description:
						id === "fixture/research-pack"
							? "A second local fixture pack for focus tasks."
							: "A local fixture pack for productivity tasks.",
					id,
					members,
					name:
						id === "fixture/research-pack"
							? "Fixture Research Pack"
							: "Fixture Productivity Pack",
				});
			}
			if (url.pathname === "/api/skills/packs/install" && method === "POST") {
				if (fixture.skillPackInstallFailures > 0) {
					fixture.skillPackInstallFailures -= 1;
					return json(route, 503, { error: "Fixture pack install failed" });
				}
				fixture.skillInstalled.add(IDS.skillAlpha);
				fixture.skillInstalled.add(IDS.skillCustom);
				fixture.skillActiveById[IDS.skillAlpha] = false;
				fixture.skillActiveById[IDS.skillCustom] = false;
				return json(route, 200, {
					installed: ["alpha-assistant", "custom-helper"],
					success: true,
				});
			}

			if (url.pathname === "/api/mcp/servers" && method === "GET") {
				return json(route, 200, {
					servers: [...fixture.mcpInstalled].map((id) => ({
						args: ["fixture"],
						command: "node",
						description: "An installed local MCP fixture.",
						enabled: false,
						name: id,
						transport: "stdio",
						url: null,
					})),
				});
			}
			if (url.pathname === "/api/mcp/catalog" && method === "GET") {
				const searchQuery = url.searchParams.get("query")?.toLowerCase() ?? "";
				const limit = url.searchParams.get("limit");
				if (limit === "40" && fixture.mcpCatalogFailures > 0) {
					fixture.mcpCatalogFailures -= 1;
					return json(route, 503, {
						error: "Fixture MCP catalog is unavailable",
					});
				}
				let servers: ReturnType<typeof mcpFixtureCards>[number][] =
					mcpFixtureCards(fixture, fixture.mcpActiveSource);
				if (limit === "12") {
					servers = servers.filter((server) => server.id === IDS.mcp);
				}
				if (searchQuery) {
					servers = servers.filter((server) =>
						[server.id, server.name, server.description].some((field) =>
							field.toLowerCase().includes(searchQuery)
						)
					);
				}
				return json(route, 200, {
					next_cursor: null,
					servers,
					total: servers.length,
				});
			}
			if (url.pathname === "/api/mcp/catalog/detail" && method === "GET") {
				const id = url.searchParams.get("id") ?? IDS.mcp;
				const card = mcpFixtureCards(fixture, fixture.mcpActiveSource).find(
					(server) => server.id === id
				);
				return json(route, 200, {
					card: {
						description: card?.description ?? "Selected MCP fixture detail.",
						has_packages: true,
						has_remotes: true,
						id,
						name: card?.name ?? id,
						transports: card?.transports ?? ["stdio"],
						version: card?.version ?? "1.0.0",
					},
					packages: [
						{
							identifier: "fixture-package",
							registry_type: "npm",
							transport: "stdio",
							version: "1.0.0",
						},
					],
					remotes: [
						{
							transport_type: "streamable-http",
							url: "https://fixture.invalid/mcp",
						},
					],
				});
			}
			if (url.pathname === "/api/mcp/catalog/install" && method === "POST") {
				const install = storeIdRequestSchema.parse(body);
				if (fixture.mcpInstallFailures > 0) {
					fixture.mcpInstallFailures -= 1;
					return json(route, 503, { error: "Fixture MCP install failed" });
				}
				const gate = fixture.mcpInstallGate;
				if (gate) {
					fixture.mcpInstallGate = null;
					await gate.promise;
				}
				fixture.mcpInstalled.add(install.id);
				return json(route, 200, {
					server: {
						args: ["fixture"],
						command: "node",
						name: install.id,
						transport: "stdio",
						url: null,
					},
					success: true,
				});
			}

			if (url.pathname === "/api/agents/catalog" && method === "GET") {
				return json(route, 200, {
					agents: [IDS.agent, IDS.contextAgent, IDS.recommendationAgent].map(
						(id) => ({
							added: fixture.agentsAdded.has(id),
							available: true,
							description: "A local agent fixture.",
							engine: "fixture-engine",
							id,
							name:
								id === IDS.agent
									? "Home Agent Fixture"
									: id === IDS.contextAgent
										? "Context Agent Fixture"
										: "For You Agent",
						})
					),
				});
			}
			if (url.pathname === "/api/agents/catalog/install" && method === "POST") {
				fixture.agentsAdded.add(storeIdRequestSchema.parse(body).id);
				return json(route, 200, { success: true });
			}

			if (url.pathname === "/api/plugins/catalog" && method === "GET") {
				return json(route, 200, {
					entries: [
						appCatalogEntry(IDS.app, "Fixture Home App", "app", "built-in"),
						appCatalogEntry(
							IDS.plugin,
							"Fixture Home Plugin",
							"plugin",
							"marketplace"
						),
					],
				});
			}
			if (url.pathname === "/api/plugins/catalog/browse" && method === "GET") {
				const source = url.searchParams.get("source") ?? "all";
				const query = url.searchParams.get("query")?.toLowerCase() ?? "";
				const origin = url.searchParams.get("origin");
				if (origin === "community") {
					const communityEntry = appCatalogEntry(
						IDS.communityPlugin,
						"Community Fixture Plugin",
						"plugin",
						"community",
						{
							origin: "community",
							repo_url: "https://github.com/fixture/community-plugin",
							reviewed: false,
						}
					);
					const communityMatches =
						!query ||
						`${communityEntry.name} ${communityEntry.description} ${communityEntry.tags.join(" ")}`
							.toLowerCase()
							.includes(query);
					return json(route, 200, {
						entries: communityMatches ? [communityEntry] : [],
						next_cursor: null,
						total: communityMatches ? 1 : 0,
					});
				}
				if (fixture.appCatalogFailures > 0) {
					fixture.appCatalogFailures -= 1;
					return json(route, 503, { error: "Fixture app catalog unavailable" });
				}
				if (query === "paging-fixture") {
					const cursor = url.searchParams.get("cursor");
					const entries = cursor
						? [
								appCatalogEntry(
									"fixture/pagination-plugin-25",
									"Pagination Plugin 25",
									"plugin",
									"marketplace",
									{ category: "Pagination", tags: ["paging-fixture"] }
								),
							]
						: Array.from({ length: 24 }, (_, index) => {
								const itemIndex = index + 1;
								return appCatalogEntry(
									`fixture/pagination-plugin-${itemIndex}`,
									`Pagination Plugin ${itemIndex}`,
									"plugin",
									"marketplace",
									{ category: "Pagination", tags: ["paging-fixture"] }
								);
							});
					return json(route, 200, {
						entries,
						next_cursor: cursor ? null : "fixture-next-page",
						total: cursor ? 25 : 24,
					});
				}
				const entries = [
					appCatalogEntry(IDS.app, "Fixture Home App", "app", "built-in", {
						category: "Productivity",
						description: "A native fixture app for the Apps tab.",
						permission_grants: ["net.fetch"],
						tags: ["fixture", "workflow"],
					}),
					...Array.from({ length: 8 }, (_, index) => {
						const itemIndex = index + 1;
						return appCatalogEntry(
							`fixture/extra-app-${itemIndex}`,
							`Fixture Extra App ${itemIndex}`,
							"app",
							"built-in",
							{
								category: "Productivity",
								description: `Productivity fixture ${itemIndex}.`,
								tags: ["fixture", "workflow"],
							}
						);
					}),
					appCatalogEntry(
						IDS.utilitiesApp,
						"Fixture Utilities App",
						"app",
						"built-in",
						{
							category: "Utilities",
							description: "A second category for shelf navigation.",
							tags: ["fixture", "utilities"],
						}
					),
					appCatalogEntry(
						IDS.plugin,
						"Fixture Home Plugin",
						"plugin",
						"marketplace",
						{
							category: "Developer tools",
							description: "A signed fixture plugin for the Plugins tab.",
							permission_grants: ["tools:read"],
							requires: {
								apps: [{ id: "fixture/required-plugin", min_version: "1.2.0" }],
								grants: ["tools:read"],
							},
							repo_url: "https://github.com/fixture/ryu-plugin",
							tags: ["fixture", "developer"],
						}
					),
					appCatalogEntry(
						IDS.urlPlugin,
						"URL Installed Plugin",
						"plugin",
						"marketplace",
						{
							category: "Developer tools",
							description: "A fixture installed through a manifest URL.",
							tags: ["fixture", "url"],
						}
					),
					appCatalogEntry(
						IDS.betaPlugin,
						"Beta Plugin Fixture",
						"plugin",
						"marketplace",
						{
							category: "Developer tools",
							description: "An unstable local fixture release.",
							stability: "beta",
							tags: ["developer", "preview"],
						}
					),
				];
				const sourceEntries = entries.filter(
					(entry) =>
						source === "all" ||
						(source === "ryu-catalog" && entry.source === "built-in") ||
						(source !== "ryu-catalog" && entry.source !== "built-in")
				);
				const filtered = query
					? sourceEntries.filter((entry) =>
							`${entry.name} ${entry.description} ${entry.tags.join(" ")}`
								.toLowerCase()
								.includes(query)
						)
					: sourceEntries;
				return json(route, 200, {
					entries: filtered,
					next_cursor: null,
					total: filtered.length,
				});
			}
			if (url.pathname === "/api/plugins/catalog/detail" && method === "GET") {
				const id = url.searchParams.get("id") ?? IDS.plugin;
				return json(route, 200, {
					description:
						id === IDS.app
							? "A native fixture app for the Apps tab."
							: id === IDS.urlPlugin
								? "A fixture installed through a manifest URL."
								: "A signed fixture plugin for the Plugins tab.",
					id,
					kind: id === IDS.app ? "app" : "plugin",
					name:
						id === IDS.app
							? "Fixture Home App"
							: id === IDS.urlPlugin
								? "URL Installed Plugin"
								: "Fixture Home Plugin",
					apiSurface: {
						commands: [
							{
								description: "Open the local fixture command.",
								id: "fixture:open",
								name: "Open fixture",
							},
						],
					},
					readme:
						"# Fixture plugin\n\nLocal README content for the Store detail proof.",
					readmeUrl: "https://github.com/fixture/ryu-plugin#readme",
					repositoryUrl: "https://github.com/fixture/ryu-plugin",
					source: "fixture",
					versions: [
						{
							installable: true,
							publishedAt: "2026-08-20T00:00:00Z",
							stability: "stable",
							url: "https://github.com/fixture/ryu-plugin/releases/tag/v1.0.0",
							version: "1.0.0",
						},
						{
							installable: true,
							publishedAt: "2026-07-20T00:00:00Z",
							stability: "stable",
							url: "https://github.com/fixture/ryu-plugin/releases/tag/v0.9.0",
							version: "0.9.0",
						},
					],
					version: "1.0.0",
				});
			}
			if (
				url.pathname === "/api/plugins/catalog/version-detail" &&
				method === "GET"
			) {
				return json(route, 200, {
					atRef: url.searchParams.get("tag"),
					description: "The historical fixture release.",
					license: "MIT",
					readme: "Historical README body.",
					stability: "stable",
					version: url.searchParams.get("tag") === "0.9.0" ? "0.9.0" : "1.0.0",
				});
			}
			if (
				url.pathname === "/api/plugins/catalog/channels" &&
				method === "GET"
			) {
				return json(route, 200, {
					channels: [
						{ channel: "stable", installable: true, version: "1.0.0" },
						{ channel: "beta", installable: true, version: "1.1.0-beta.1" },
					],
				});
			}
			if (url.pathname === "/api/plugins" && method === "GET") {
				return json(route, 200, {
					apps: [...fixture.appsInstalled].map((id) =>
						appLifecycle(fixture, id)
					),
				});
			}
			if (
				url.pathname ===
					`/api/plugins/${encodeURIComponent(IDS.app)}/install` &&
				method === "POST"
			) {
				if (fixture.appInstallFailures > 0) {
					fixture.appInstallFailures -= 1;
					return json(route, 503, { error: "Fixture app install failed" });
				}
				fixture.appsInstalled.add(IDS.app);
				return json(route, 200, {
					app: {
						approved_grants: [],
						created_at: "2026-08-01T00:00:00Z",
						enabled: false,
						id: IDS.app,
						updated_at: "2026-08-01T00:00:00Z",
						version: "1.0.0",
					},
				});
			}
			const appLifecycleMatch = url.pathname.match(
				/^\/api\/plugins\/([^/]+)\/(enable|disable|uninstall)$/
			);
			if (appLifecycleMatch && method === "POST") {
				const id = decodeURIComponent(appLifecycleMatch[1] ?? "");
				const action = appLifecycleMatch[2];
				if (action === "enable") {
					fixture.appEnabled.add(id);
					return json(route, 200, {
						app: {
							approved_grants: ["net.fetch"],
							created_at: "2026-08-01T00:00:00Z",
							enabled: true,
							id,
							updated_at: "2026-08-02T00:00:00Z",
							version: "1.0.0",
						},
					});
				}
				if (action === "disable") {
					fixture.appEnabled.delete(id);
					return json(route, 200, {
						app: {
							approved_grants: [],
							created_at: "2026-08-01T00:00:00Z",
							enabled: false,
							id,
							updated_at: "2026-08-02T00:00:00Z",
							version: "1.0.0",
						},
					});
				}
				fixture.appsInstalled.delete(id);
				fixture.appEnabled.delete(id);
				return json(route, 200, { removed: id, success: true });
			}
			const appUpdateMatch = url.pathname.match(
				/^\/api\/plugins\/([^/]+)\/update$/
			);
			if (appUpdateMatch && method === "POST") {
				const id = decodeURIComponent(appUpdateMatch[1] ?? "");
				const update = storePluginUpdateSchema.parse(body ?? {});
				fixture.appChannels[id] = update.channel ?? null;
				return json(route, 200, {
					app: {
						approved_grants: [],
						created_at: "2026-08-01T00:00:00Z",
						enabled: fixture.appEnabled.has(id),
						id,
						updated_at: "2026-08-02T00:00:00Z",
						version: "1.0.0",
					},
				});
			}
			if (
				url.pathname === "/api/plugins/catalog/install" &&
				method === "POST"
			) {
				if (fixture.pluginInstallFailures > 0) {
					fixture.pluginInstallFailures -= 1;
					return json(route, 503, { error: "Fixture plugin install failed" });
				}
				const install = storePluginInstallSchema.parse(body);
				fixture.appsInstalled.add(install.id);
				fixture.appChannels[install.id] = install.channel ?? null;
				return json(route, 200, { success: true });
			}
			if (url.pathname === "/api/plugins/install" && method === "POST") {
				if (fixture.appUrlInstallFailures > 0) {
					fixture.appUrlInstallFailures -= 1;
					return json(route, 503, { error: "Fixture URL install failed" });
				}
				const install = storeUrlInstallSchema.parse(body);
				fixture.appsInstalled.add(
					install.url.includes("community-plugin")
						? IDS.communityPlugin
						: IDS.urlPlugin
				);
				return json(route, 200, { success: true });
			}
			if (url.pathname === "/api/catalog/scan" && method === "POST") {
				if (fixture.auditFailures > 0) {
					fixture.auditFailures -= 1;
					return json(route, 503, { error: "Fixture audit unavailable" });
				}
				const gate = fixture.auditGate;
				if (gate) {
					fixture.auditGate = null;
					await gate.promise;
				}
				return json(route, 200, {
					agent_id: "fixture-reviewer",
					assessment: {
						confidence: "high",
						evidence: ["The fixture README is present."],
						limitations: ["Local fixture evidence only."],
						recommendations: [
							{
								priority: "low",
								action: "Review the repository.",
								reason: "Confirm the listing before installing.",
							},
						],
						score: 88,
						summary: "Local fixture audit result.",
					},
					conversationId: "fixture-audit-conversation",
					model: "fixture-reviewer-model",
					report: "Local fixture report.",
					status: "complete",
				});
			}

			if (strictEngines) {
				diagnostic.unknown.push({
					method,
					path: url.pathname,
					search: url.search,
					body,
				});
				return json(route, 501, {
					error: `Unmapped Engines fixture contract: ${method} ${url.pathname}${url.search}`,
				});
			}
			return json(route, 200, {});
		}
	);
	return fixture;
}

async function openHome(page: Page): Promise<Fixture> {
	const fixture = await installLocalFixture(page);
	await page.goto(STORY_URL);
	await expect(page.getByRole("heading", { name: "For you" })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Home GGUF Candidate" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Home Skill Fixture" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Home MCP Fixture" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Home Agent Fixture" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Fixture Home App" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Fixture Home Plugin" })
	).toBeVisible();
	return fixture;
}

async function openStoreSection(
	page: Page,
	section: "apps" | "engines" | "plugins" | "skills" | "mcp"
): Promise<Fixture> {
	const fixture = await installLocalFixture(
		page,
		API_ORIGIN,
		section === "engines"
	);
	await page.goto(`${STORY_URL}?section=${section}`);
	const selectedTab = page.getByRole("tab", { selected: true });
	await expect(selectedTab).toContainText(
		{
			apps: "Apps",
			engines: "Engines",
			plugins: "Plugins",
			skills: "Skills",
			mcp: "MCP",
		}[section]
	);
	if (section === "engines") {
		await expect(page.getByRole("button", { name: "llama.cpp" })).toBeVisible();
	}
	return fixture;
}

function callsFor(fixture: Fixture, method: string, path: string) {
	return fixture.calls.filter(
		(call) => call.method === method && call.path === path
	);
}

async function prepareEvidenceCapture(page: Page) {
	const indicator = page.locator('[data-slot="tabs-indicator"]');
	if (await indicator.count()) {
		await indicator.evaluateAll(async (elements) => {
			await Promise.all(
				elements.flatMap((element) =>
					element
						.getAnimations()
						.map((animation) => animation.finished.catch(() => undefined))
				)
			);
		});
	}
	await page.evaluate(() => {
		if (document.activeElement instanceof HTMLElement) {
			document.activeElement.blur();
		}
	});
	await page.mouse.move(1430, 990);
}

function deferred() {
	let release: () => void = () => undefined;
	const promise = new Promise<void>((resolvePromise) => {
		release = resolvePromise;
	});
	return { promise, release };
}

test("For you cadence, refresh, hide and re-enable persist through the Core fixture", async ({
	page,
}) => {
	const fixture = await openHome(page);
	const forYou = page
		.locator('[data-slot="marketplace-home"] > div > section')
		.first();
	const cadence = page.getByRole("combobox", {
		name: "Recommendation refresh cadence",
	});
	for (const value of ["daily", "monthly", "weekly"] as const) {
		await cadence.selectOption(value);
		await expect(cadence).toHaveValue(value);
		await expect
			.poll(() => callsFor(fixture, "PUT", "/api/gateway/config").length)
			.toBe(value === "daily" ? 1 : value === "monthly" ? 2 : 3);
		const write = callsFor(fixture, "PUT", "/api/gateway/config").at(-1);
		expect(write?.body).toEqual({
			marketplace_recommendations: { cadence: value, enabled: true },
		});
	}

	fixture.refreshFailures = 1;
	await page.getByRole("button", { name: "Refresh For you" }).click();
	await expect(
		forYou.getByRole("button", { name: "For You Gemma" })
	).toBeVisible();
	await expect
		.poll(
			() => callsFor(fixture, "POST", "/api/marketplace/recommendations").length
		)
		.toBe(1);
	await page.getByRole("button", { name: "Refresh For you" }).click();
	await expect(
		page.getByRole("button", { name: "Refreshed For You Gemma" })
	).toBeVisible();
	expect(
		callsFor(fixture, "POST", "/api/marketplace/recommendations").map(
			(call) => call.search
		)
	).toEqual(["?refresh=true", "?refresh=true"]);
	expect(
		callsFor(fixture, "POST", "/api/marketplace/recommendations").map(
			(call) => call.body
		)
	).toEqual([null, null]);

	await page.getByRole("button", { name: "Hide For you" }).click();
	await expect(
		page.getByRole("button", { name: "Re-enable For you" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Refreshed For You Gemma" })
	).toHaveCount(0);
	await page.getByRole("button", { name: "Re-enable For you" }).click();
	await expect(
		page.getByRole("button", { name: "Refreshed For You Gemma" })
	).toBeVisible();
	expect(
		callsFor(fixture, "PUT", "/api/marketplace/recommendations/preference").map(
			(call) => call.body
		)
	).toEqual([{ hidden: true }, { hidden: false }]);

	await page.reload();
	await expect(
		page.getByRole("combobox", { name: "Recommendation refresh cadence" })
	).toHaveValue("weekly");
	await expect(
		page.getByRole("button", { name: "Refreshed For You Gemma" })
	).toBeVisible();
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-home-recommendations.png"),
	});
});

test("every recommendation card opens its exact item in the matching realm", async ({
	page,
}) => {
	const fixture = await openHome(page);
	const destinations = [
		{
			item: "For You Gemma",
			tab: "Models",
			id: IDS.recommendation,
			path: "/api/models/catalog/detail",
		},
		{
			item: "For You Skill",
			tab: "Skills",
			id: IDS.recommendationSkill,
			path: "/api/skills/catalog/detail",
		},
		{
			item: "For You MCP",
			tab: "MCP",
			id: IDS.recommendationMcp,
			path: "/api/mcp/catalog/detail",
		},
		{
			item: "For You Agent",
			tab: "Agents",
			id: IDS.recommendationAgent,
			path: null,
		},
		{
			item: "For You App",
			tab: "Apps",
			id: IDS.recommendationApp,
			path: "/api/plugins/catalog/detail",
		},
		{
			item: "For You Plugin",
			tab: "Plugins",
			id: IDS.recommendationPlugin,
			path: "/api/plugins/catalog/detail",
		},
	];
	for (const [index, destination] of destinations.entries()) {
		if (index > 0) {
			await page.goto(STORY_URL);
			await expect(
				page.getByRole("heading", { name: "For you" })
			).toBeVisible();
		}
		const forYou = page
			.locator('[data-slot="marketplace-home"] > div > section')
			.first();
		await forYou.getByRole("button", { name: destination.item }).click();
		const selectedTab = page.locator(
			'[data-slot="store-section-tabs-scroller"] [data-slot="tabs-trigger"][data-active]'
		);
		await expect(selectedTab).toContainText(destination.tab);
		const selectedAccessibleTab = page.locator(
			'[data-slot="store-section-tabs-scroller"] [role="tab"][aria-selected="true"]'
		);
		await expect(selectedAccessibleTab).toHaveCount(1);
		await expect(selectedAccessibleTab).toContainText(destination.tab);
		const detailPath = destination.path;
		if (detailPath) {
			await expect
				.poll(() => {
					const detailCall = callsFor(fixture, "GET", detailPath).at(-1);
					return new URLSearchParams(detailCall?.search).get("id");
				})
				.toBe(destination.id);
		} else {
			await expect(
				page.getByText("For You Agent", { exact: true }).first()
			).toBeVisible();
		}
	}
});

test("each Home shelf card selects its exact listing in the matching realm", async ({
	page,
}) => {
	const fixture = await openHome(page);
	const destinations = [
		{
			item: "Home GGUF Candidate",
			tab: "Models",
			id: IDS.model,
			path: "/api/models/catalog/detail",
		},
		{
			item: "Home Skill Fixture",
			tab: "Skills",
			id: IDS.skill,
			path: "/api/skills/catalog/detail",
		},
		{
			item: "Home MCP Fixture",
			tab: "MCP",
			id: IDS.mcp,
			path: "/api/mcp/catalog/detail",
		},
		{
			item: "Home Agent Fixture",
			tab: "Agents",
			id: IDS.agent,
			path: null,
		},
		{
			item: "Fixture Home App",
			tab: "Apps",
			id: IDS.app,
			path: "/api/plugins/catalog/detail",
		},
		{
			item: "Fixture Home Plugin",
			tab: "Plugins",
			id: IDS.plugin,
			path: "/api/plugins/catalog/detail",
		},
	];
	for (const [index, destination] of destinations.entries()) {
		if (index > 0) {
			await page.goto(STORY_URL);
			await expect(
				page.getByRole("heading", { name: "For you" })
			).toBeVisible();
		}
		const shelf = page
			.locator('[data-slot="marketplace-home-shelf"]')
			.filter({ hasText: destination.item });
		await shelf.getByRole("button", { name: destination.item }).click();
		const selectedTab = page.locator(
			'[data-slot="store-section-tabs-scroller"] [data-slot="tabs-trigger"][data-active]'
		);
		await expect(selectedTab).toHaveCount(1);
		await expect(selectedTab).toContainText(destination.tab);
		const selectedAccessibleTab = page.locator(
			'[data-slot="store-section-tabs-scroller"] [role="tab"][aria-selected="true"]'
		);
		await expect(selectedAccessibleTab).toHaveCount(1);
		await expect(selectedAccessibleTab).toContainText(destination.tab);
		if (index === 0) {
			mkdirSync(EVIDENCE_DIR, { recursive: true });
			await prepareEvidenceCapture(page);
			await expect(
				page.getByText(/The total tokens the model can read/)
			).not.toBeVisible();
			await page.screenshot({
				path: resolve(
					EVIDENCE_DIR,
					"marketplace-store-home-card-navigation.png"
				),
			});
		}
		const detailPath = destination.path;
		if (detailPath) {
			if (index === 0) {
				await expect
					.poll(() => callsFor(fixture, "GET", detailPath).at(-1)?.search)
					.toContain("id");
			}
			await expect
				.poll(() => {
					const detailCall = callsFor(fixture, "GET", detailPath).at(-1);
					return new URLSearchParams(detailCall?.search).get("id");
				})
				.toBe(destination.id);
		} else {
			await expect(
				page.getByText("Home Agent Fixture", { exact: true }).first()
			).toBeVisible();
		}
	}
});

test("every Home shelf Add and like uses its realm request and reads state back", async ({
	page,
}) => {
	const fixture = await openHome(page);
	fixture.installFailures["/api/models/catalog/install"] = 1;
	const modelsShelf = page
		.locator('[data-slot="marketplace-home-shelf"]')
		.filter({ hasText: "Popular models" });
	const modelCard = modelsShelf
		.getByRole("button", { name: "Home GGUF Candidate" })
		.locator("xpath=..");
	const modelAction = modelCard.locator('button[data-slot="button"]');
	await modelAction.click();
	await expect(modelAction).toHaveText("Add");
	await expect
		.poll(() => callsFor(fixture, "POST", "/api/models/catalog/install").length)
		.toBe(1);
	const gate = deferred();
	fixture.installGate = gate;
	await modelAction.click();
	await expect(modelAction).toHaveText("Installing…");
	expect(modelAction).toBeDisabled();
	await expect
		.poll(() => callsFor(fixture, "POST", "/api/models/catalog/install").length)
		.toBe(2);
	gate.release();
	await expect(modelAction).toHaveText("Added");
	expect(modelAction).toBeDisabled();
	const modelInstalls = callsFor(
		fixture,
		"POST",
		"/api/models/catalog/install"
	);
	expect(modelInstalls.map((call) => call.body)).toEqual([
		{ id: IDS.model, file: "home-gemma-Q4_K_M.gguf", format: "gguf" },
		{ id: IDS.model, file: "home-gemma-Q4_K_M.gguf", format: "gguf" },
	]);
	const detailCalls = callsFor(fixture, "GET", "/api/models/catalog/detail");
	expect(detailCalls).toHaveLength(2);
	expect(
		detailCalls.map((call) => new URLSearchParams(call.search).get("id"))
	).toEqual([IDS.model, IDS.model]);
	for (const snapshot of [
		{
			format: "safetensors",
			id: "fixture/home-safetensors",
			name: "Home Safetensors Snapshot",
		},
		{ format: "mlx", id: "fixture/home-mlx", name: "Home MLX Snapshot" },
	]) {
		const card = modelsShelf
			.getByRole("button", { name: snapshot.name })
			.locator("xpath=..");
		const action = card.locator('button[data-slot="button"]');
		await action.click();
		await expect(action).toHaveText("Added");
		expect(
			callsFor(fixture, "POST", "/api/models/catalog/install").at(-1)?.body
		).toEqual({
			id: snapshot.id,
			format: snapshot.format,
		});
	}

	const shelfCases = [
		{
			name: "Home Skill Fixture",
			path: "/api/skills/catalog/install",
			body: {
				id: IDS.skill,
				promptForTargets: true,
				source: "fixture-skill-registry",
			},
		},
		{
			name: "Home MCP Fixture",
			path: "/api/mcp/catalog/install",
			body: { force: false, id: IDS.mcp },
		},
		{
			name: "Home Agent Fixture",
			path: "/api/agents/catalog/install",
			body: { id: IDS.agent },
		},
		{
			name: "Fixture Home App",
			path: `/api/plugins/${encodeURIComponent(IDS.app)}/install`,
			body: null,
		},
		{
			name: "Fixture Home Plugin",
			path: "/api/plugins/catalog/install",
			body: { id: IDS.plugin },
		},
	];
	for (const row of shelfCases) {
		const shelf = page
			.locator('[data-slot="marketplace-home-shelf"]')
			.filter({ hasText: row.name });
		const add = shelf.getByRole("button", { name: "Add" }).first();
		await add.click();
		await expect(shelf.getByRole("button", { name: "Added" })).toBeDisabled();
		const write = callsFor(fixture, "POST", row.path).at(-1);
		expect(write?.body).toEqual(row.body);
	}

	const likeTargets = [
		{ id: IDS.model, name: "Home GGUF Candidate" },
		{ id: "fixture/home-safetensors", name: "Home Safetensors Snapshot" },
		{ id: "fixture/home-mlx", name: "Home MLX Snapshot" },
		{ id: IDS.recommendation, name: "For You Gemma" },
		{ id: IDS.skill, name: "Home Skill Fixture" },
		{ id: IDS.mcp, name: "Home MCP Fixture" },
		{ id: IDS.agent, name: "Home Agent Fixture" },
		{ id: IDS.contextAgent, name: "Context Agent Fixture" },
		{ id: IDS.app, name: "Fixture Home App" },
		{ id: IDS.plugin, name: "Fixture Home Plugin" },
	];
	for (const target of likeTargets) {
		const shelf = page
			.locator('[data-slot="marketplace-home-shelf"]')
			.filter({ hasText: target.name });
		const card = shelf
			.getByRole("button", { name: target.name })
			.locator("xpath=..");
		await card.getByRole("button", { name: "Like (2)" }).click();
		const unlike = card.getByRole("button", { name: "Unlike (3)" });
		await expect(unlike).toHaveAttribute("aria-pressed", "true");
		expect(
			callsFor(fixture, "POST", "/api/marketplace/likes").at(-1)?.body
		).toEqual({
			namespace: target.id,
		});
		await unlike.click();
		const like = card.getByRole("button", { name: "Like (2)" });
		await expect(like).toHaveAttribute("aria-pressed", "false");
		expect(
			callsFor(fixture, "DELETE", "/api/marketplace/likes").at(-1)?.body
		).toEqual({
			namespace: target.id,
		});
		expect(fixture.likes[target.id]).toEqual({ count: 2, liked: false });
	}

	const finalLike = page
		.locator('[data-slot="marketplace-home-shelf"]')
		.filter({ hasText: "Fixture Home Plugin" })
		.getByTestId("item-like-button");
	await expect(finalLike).not.toHaveClass(/is-bursting/);
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-home-shelves-added.png"),
	});
});

test("the shelf Get context action installs the selected item and reads it back", async ({
	page,
}) => {
	const fixture = await openHome(page);
	const agentsShelf = page
		.locator('[data-slot="marketplace-home-shelf"]')
		.filter({ hasText: "Context Agent Fixture" });
	await agentsShelf
		.getByRole("button", { name: "Context Agent Fixture" })
		.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Get" }).click();
	await expect(agentsShelf.getByRole("button", { name: "Added" })).toHaveCount(
		1
	);
	expect(
		callsFor(fixture, "POST", "/api/agents/catalog/install").at(-1)?.body
	).toEqual({
		id: IDS.contextAgent,
	});
});

test("global result heading carries the query to a realm and empty-state clear restores the selected realm", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page);
	await page.goto(STORY_URL);
	const globalSearch = page.getByRole("searchbox", {
		name: "Search the whole marketplace…",
	});
	await globalSearch.fill("Heading Needle");
	await expect(
		page.getByRole("button", { name: "Heading Needle Model" })
	).toBeVisible();
	await page.getByRole("button", { name: /^Models\s+1$/ }).click();
	await expect(page.getByRole("tab", { name: "Models" })).toHaveAttribute(
		"aria-selected",
		"true"
	);
	await expect(globalSearch).toHaveValue("");
	const localSearch = page.getByRole("textbox", {
		name: /Search by name, org, tag, or type/,
	});
	await expect(localSearch).toHaveValue("Heading Needle");
	await expect(
		page.getByRole("button", { name: "Heading Needle Model" })
	).toBeVisible();
	const matchingModelRequest = fixture.calls.find(
		(call) =>
			call.method === "GET" &&
			call.path === "/api/models/catalog" &&
			new URLSearchParams(call.search).get("query") === "Heading Needle"
	);
	expect(matchingModelRequest).toBeDefined();

	await page.getByRole("tab", { name: "Agents" }).click();
	await globalSearch.fill("no-such-fixture-item");
	await expect(page.getByText("Nothing found")).toBeVisible();
	await page.getByRole("button", { name: "Clear search" }).last().click();
	await expect(globalSearch).toHaveValue("");
	await expect(page.getByRole("tab", { name: "Agents" })).toHaveAttribute(
		"aria-selected",
		"true"
	);
	await expect(
		page.getByRole("button", { name: "Home Agent Fixture" })
	).toBeVisible();
});

test("See all on every shelf opens its matching catalog section", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	const destinations = [
		{ section: "Featured skills", tab: "Skills" },
		{ section: "Popular models", tab: "Models" },
		{ section: "MCP servers", tab: "MCP" },
		{ section: "Agents", tab: "Agents" },
		{ section: "Apps", tab: "Apps" },
		{ section: "Plugins", tab: "Plugins" },
	];
	for (const [index, destination] of destinations.entries()) {
		if (index === 0) {
			await openHome(page);
		} else {
			await page.goto(STORY_URL);
			await expect(
				page.getByRole("heading", { name: "For you" })
			).toBeVisible();
		}
		const shelf = page
			.locator('[data-slot="marketplace-home-shelf"]')
			.filter({ hasText: destination.section });
		await expect(shelf).toHaveCount(1);
		await shelf.getByRole("button", { name: "Open section" }).click();
		const selectedTab = page.locator(
			'[data-slot="store-section-tabs-scroller"] [data-slot="tabs-trigger"][data-active]'
		);
		await expect(selectedTab).toContainText(destination.tab);
		const selectedAccessibleTab = page.locator(
			'[data-slot="store-section-tabs-scroller"] [role="tab"][aria-selected="true"]'
		);
		await expect(selectedAccessibleTab).toHaveCount(1);
		await expect(selectedAccessibleTab).toContainText(destination.tab);
		await expect(page.locator("body")).not.toHaveText("");
		if (destination.section === "Featured skills") {
			await expect(
				page.getByRole("button", { name: "Search", exact: true })
			).toBeVisible();
			await expect(
				page.getByRole("button", { name: /Home Skill Fixture/ })
			).toBeVisible();
			const modelsTab = page
				.locator(
					'[data-slot="store-section-tabs-scroller"] [data-slot="tabs-trigger"]'
				)
				.filter({ hasText: "Models" });
			expect(
				await modelsTab.evaluate((element) => element.matches(":focus"))
			).toBe(false);
			mkdirSync(EVIDENCE_DIR, { recursive: true });
			await prepareEvidenceCapture(page);
			await page.screenshot({
				path: resolve(EVIDENCE_DIR, "marketplace-store-home-see-all.png"),
			});
		}
	}
	expect(pageErrors).toEqual([]);
});

test("Skills catalog list failure retries the exact read and restores results", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page);
	fixture.skillCatalogFailures = 1;
	await page.goto(`${STORY_URL}?section=skills`);
	await expect(page.getByText("Couldn't load skills")).toBeVisible();
	const initialReadCount = callsFor(
		fixture,
		"GET",
		"/api/skills/catalog"
	).length;
	expect(initialReadCount).toBeGreaterThan(0);
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(
		page.getByRole("button", { name: /Home Skill Fixture/ })
	).toBeVisible();
	const reads = callsFor(fixture, "GET", "/api/skills/catalog");
	expect(reads.length).toBeGreaterThan(initialReadCount);
	for (const read of reads) {
		const query = new URLSearchParams(read.search);
		expect(query.get("limit")).toBe("120");
		expect(query.get("source")).toBe("all");
	}
});

test("MCP catalog list failure offers a retry and restores catalog cards", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page);
	fixture.mcpCatalogFailures = 2;
	await page.goto(`${STORY_URL}?section=mcp`);
	await expect
		.poll(() => callsFor(fixture, "GET", "/api/mcp/catalog").length)
		.toBe(2);
	for (const read of callsFor(fixture, "GET", "/api/mcp/catalog")) {
		expect(new URLSearchParams(read.search).get("limit")).toBe("40");
	}
	await expect(page.getByText(/Couldn't load MCP servers/)).toBeVisible();
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(
		page.getByRole("button", { name: "Home MCP Fixture" })
	).toBeVisible();
	const reads = callsFor(fixture, "GET", "/api/mcp/catalog");
	expect(reads).toHaveLength(3);
	expect(new URLSearchParams(reads.at(-1)?.search).get("limit")).toBe("40");
});

test("Skills search, sort, friendly names, and Installed filters preserve their state", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "skills");
	await page.getByRole("button", { name: "Search", exact: true }).click();
	const search = page.getByPlaceholder("Search skills…");
	await search.fill("alpha");
	const alpha = page.getByRole("button", { name: /Alpha Assistant/i });
	await expect(alpha).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Home Skill Fixture/ })
	).toHaveCount(0);
	const queryRead = callsFor(fixture, "GET", "/api/skills/catalog").at(-1);
	expect(new URLSearchParams(queryRead?.search).get("query")).toBe("alpha");
	expect(new URLSearchParams(queryRead?.search).get("limit")).toBe("120");

	await page.getByLabel("Clear search").click();
	await expect(
		page.getByRole("button", { name: /Home Skill Fixture/ })
	).toBeVisible();
	await page.getByRole("button", { name: "Filters" }).click();
	const sort = page.getByRole("combobox").first();
	await expect(sort).toBeVisible();
	await sort.click();
	const nameSort = page.getByRole("option", {
		exact: true,
		name: "Name (A–Z)",
	});
	await expect(nameSort).toBeVisible();
	await nameSort.click();
	await expect(sort).toContainText("Name (A–Z)");
	const homeSkill = page.getByRole("button", { name: /Home Skill Fixture/ });
	const installedSkill = page.getByRole("button", { name: /Installed Skill/ });
	const homeBounds = await homeSkill.boundingBox();
	const installedBounds = await installedSkill.boundingBox();
	expect(homeBounds?.y).toBeLessThan(
		installedBounds?.y ?? Number.POSITIVE_INFINITY
	);

	const friendly = page.getByRole("switch", { name: "Friendly names" });
	await expect(friendly).toHaveAttribute("aria-checked", "true");
	await friendly.click();
	await expect(friendly).toHaveAttribute("aria-checked", "false");
	await expect(
		page.getByRole("button", { name: /alpha assistant/ })
	).toBeVisible();
	await page.getByRole("button", { name: "Search", exact: true }).click();
	await page.getByPlaceholder("Search skills…").fill("no-such-skill-fixture");
	await expect(page.getByText("No skills found")).toBeVisible();
	await page.getByRole("button", { name: "Clear filters" }).click();
	await expect(
		page.getByRole("button", { name: /Home Skill Fixture/ })
	).toBeVisible();
	await page.getByRole("button", { name: "Filters" }).click();
	const addedOnly = page.getByRole("switch", { name: "Added only" });
	await expect(addedOnly).toBeVisible();
	await addedOnly.click();
	await expect(
		page.getByRole("button", { name: /Installed Skill/ })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Home Skill Fixture/ })
	).toHaveCount(0);
	const installedRead = callsFor(fixture, "GET", "/api/skills/catalog").at(-1);
	expect(new URLSearchParams(installedRead?.search).get("installed_only")).toBe(
		"true"
	);
	const globalInstalled = page
		.getByRole("button", {
			name: "Installed",
			exact: true,
		})
		.first();
	await expect(globalInstalled).toHaveAttribute("aria-pressed", "false");
	await globalInstalled.click();
	await expect(globalInstalled).toHaveAttribute("aria-pressed", "true");
	await expect(addedOnly).toHaveAttribute("aria-checked", "true");
	await page.reload();
	await page.getByRole("button", { name: "Filters" }).click();
	await expect(
		page.getByRole("switch", { name: "Friendly names" })
	).toHaveAttribute("aria-checked", "false");
});

test("Skills marketplace form validates, retries, reorders, and removes exact sources", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "skills");
	fixture.skillSourceAddFailures = 1;
	await page.getByRole("button", { name: "Filters" }).click();
	const newSkillNavigation = page.evaluate(
		() =>
			new Promise<string>((resolveNavigation) => {
				window.addEventListener(
					"marketplace-store:tab",
					(event) => {
						const decode = window.__marketplaceHomeDecodeStringEvent;
						if (!decode) {
							throw new Error(
								"Marketplace Home event decoder is not installed"
							);
						}
						resolveNavigation(decode(event));
					},
					{ once: true }
				);
			})
	);
	await page.getByRole("button", { name: "New skill" }).click();
	expect(await newSkillNavigation).toBe("/skills/new");
	await page
		.getByRole("button", { name: "Add marketplace", exact: true })
		.first()
		.click();
	await page
		.getByRole("button", { name: "Add marketplace", exact: true })
		.last()
		.click();
	await expect(
		page.getByText("Enter a repo, git URL, or local path")
	).toBeVisible();
	expect(callsFor(fixture, "POST", "/api/catalog/sources")).toHaveLength(0);
	await page
		.getByLabel("Repo, git URL, or local path")
		.fill("owner/my-marketplace");
	await page.getByLabel("Display name (optional)").fill("My Marketplace");
	await page
		.getByRole("button", { name: "Add marketplace", exact: true })
		.last()
		.click();
	await expect(
		page.getByText("/api/catalog/sources failed: 503")
	).toBeVisible();
	await page
		.getByRole("button", { name: "Add marketplace", exact: true })
		.last()
		.click();
	await expect(
		page.getByRole("button", { name: "Add marketplace", exact: true }).first()
	).toBeVisible();
	const additions = callsFor(fixture, "POST", "/api/catalog/sources");
	expect(additions.map((call) => call.body)).toEqual([
		{
			base_url: "owner/my-marketplace",
			display_name: "My Marketplace",
			id: "mp-my-marketplace",
			kind: "skill",
		},
		{
			base_url: "owner/my-marketplace",
			display_name: "My Marketplace",
			id: "mp-my-marketplace",
			kind: "skill",
		},
	]);
	expect(fixture.skillSources.map((source) => source.id)).toContain(
		"mp-my-marketplace"
	);

	await page.reload();
	await page.getByRole("button", { name: "Filters" }).click();
	await page
		.getByRole("button", { name: "Add marketplace", exact: true })
		.first()
		.click();
	await expect(page.getByText("My Marketplace", { exact: true })).toBeVisible();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-skills-sources.png"),
	});
	await page.getByRole("button", { name: "Move My Marketplace up" }).click();
	expect(
		callsFor(fixture, "POST", "/api/catalog/sources/reorder").at(-1)?.body
	).toEqual({
		direction: "up",
		id: "mp-my-marketplace",
		kind: "skill",
	});
	await page.getByRole("button", { name: "Move My Marketplace down" }).click();
	expect(
		callsFor(fixture, "POST", "/api/catalog/sources/reorder").at(-1)?.body
	).toEqual({
		direction: "down",
		id: "mp-my-marketplace",
		kind: "skill",
	});
	await page.getByRole("button", { name: "Delete My Marketplace" }).click();
	expect(
		callsFor(fixture, "DELETE", "/api/catalog/sources").at(-1)?.body
	).toEqual({
		id: "mp-my-marketplace",
		kind: "skill",
	});
	await expect(page.getByText("My Marketplace", { exact: true })).toHaveCount(
		0
	);
	expect(
		fixture.skillSources.some((source) => source.id === "mp-my-marketplace")
	).toBe(false);
});

test("Skills packs support keyboard navigation, open/back, and retryable install readback", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page);
	fixture.skillPackInstallFailures = 1;
	await page.goto(`${STORY_URL}?section=skills`);
	const productivityPack = page.getByRole("button", {
		name: "Open the Fixture Productivity Pack pack (2 skills)",
	});
	const researchPack = page.getByRole("button", {
		name: "Open the Fixture Research Pack pack (1 skills)",
	});
	await productivityPack.focus();
	await productivityPack.press("ArrowRight");
	await expect(researchPack).toBeFocused();
	await researchPack.press("ArrowLeft");
	await expect(productivityPack).toBeFocused();
	await productivityPack.press("ArrowDown");
	await expect(researchPack).toBeFocused();
	await researchPack.press("ArrowUp");
	await expect(productivityPack).toBeFocused();
	await productivityPack.press("End");
	await expect(researchPack).toBeFocused();
	await researchPack.press("Home");
	await expect(productivityPack).toBeFocused();
	await productivityPack.press("Enter");
	await expect(
		page.getByRole("button", { name: "Back to packs" })
	).toBeVisible();
	await expect
		.poll(() => callsFor(fixture, "GET", "/api/skills/packs/detail").length)
		.toBe(1);
	expect(
		new URLSearchParams(
			callsFor(fixture, "GET", "/api/skills/packs/detail").at(-1)?.search
		).get("id")
	).toBe("fixture/productivity-pack");
	await page.getByRole("button", { name: "Back to packs" }).click();
	const installPack = page.getByRole("button", {
		name: "Install the Fixture Productivity Pack pack",
	});
	await installPack.click();
	await expect(installPack).toBeVisible();
	await installPack.click();
	await productivityPack.click();
	await expect(
		page.getByRole("button", { name: "alpha assistant is installed" })
	).toBeVisible();
	expect(
		callsFor(fixture, "POST", "/api/skills/packs/install").map(
			(call) => call.body
		)
	).toEqual([
		{ id: "fixture/productivity-pack" },
		{ id: "fixture/productivity-pack" },
	]);
	await expect
		.poll(() => callsFor(fixture, "GET", "/api/skills").length)
		.toBeGreaterThan(0);
	expect(fixture.skillInstalled.has(IDS.skillAlpha)).toBe(true);
	expect(fixture.skillInstalled.has(IDS.skillCustom)).toBe(true);
});

test("Skills detail Add retries, activates from persisted state, edits, and closes", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page);
	fixture.skillInstallFailures = 1;
	await page.goto(`${STORY_URL}?section=skills`);
	const alphaCard = page.getByRole("button", { name: /alpha assistant/i });
	await alphaCard.click();
	await expect
		.poll(() => {
			const detail = callsFor(fixture, "GET", "/api/skills/catalog/detail").at(
				-1
			);
			return new URLSearchParams(detail?.search).get("id");
		})
		.toBe(IDS.skillAlpha);
	const repositoryLink = page.getByRole("link", { name: "GitHub" });
	await expect(repositoryLink).toHaveAttribute(
		"href",
		"https://fixture.invalid/skills"
	);
	await expect(repositoryLink).toHaveAttribute("target", "_blank");
	await expect(repositoryLink).toHaveAttribute("rel", "noopener noreferrer");
	await page
		.getByRole("button", { name: "More by Fixture Skills Registry" })
		.click();
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await page.getByRole("button", { name: "Filters" }).click();
	await expect(page.getByText("Org: Fixture Skills Registry")).toBeVisible();
	await page
		.getByRole("button", {
			name: "Remove filter Org: Fixture Skills Registry",
		})
		.click();
	await expect(page.getByText("Org: Fixture Skills Registry")).toHaveCount(0);
	await page.getByRole("button", { name: /alpha assistant/i }).click();
	await page
		.getByRole("button", { name: "references/DETAIL.md", exact: true })
		.click();
	await expect(
		page.getByText("Reference content for selection proof.")
	).toBeVisible();
	const installedReadsBeforeInstall = callsFor(
		fixture,
		"GET",
		"/api/skills"
	).length;
	const addSkill = page.getByRole("button", { name: "Add skill" });
	await addSkill.click();
	await expect
		.poll(() => callsFor(fixture, "POST", "/api/skills/catalog/install").length)
		.toBe(1);
	await addSkill.click();
	await expect(page.getByText("Added", { exact: true }).first()).toBeVisible();
	expect(
		callsFor(fixture, "POST", "/api/skills/catalog/install").map(
			(call) => call.body
		)
	).toEqual([
		{
			id: IDS.skillAlpha,
			promptForTargets: true,
			source: "fixture-skill-registry",
		},
		{
			id: IDS.skillAlpha,
			promptForTargets: true,
			source: "fixture-skill-registry",
		},
	]);
	await expect
		.poll(() => callsFor(fixture, "GET", "/api/skills").length)
		.toBeGreaterThan(installedReadsBeforeInstall);
	expect(fixture.skillInstalled.has(IDS.skillAlpha)).toBe(true);

	const enableSkill = page.getByRole("switch", { name: "Disabled" });
	await enableSkill.click();
	await expect(page.getByRole("switch", { name: "Enabled" })).toHaveAttribute(
		"aria-checked",
		"true"
	);
	expect(
		callsFor(fixture, "POST", "/api/skills/activate").at(-1)?.body
	).toEqual({
		active: true,
		id: IDS.skillAlpha,
	});
	expect(fixture.skillActiveById[IDS.skillAlpha]).toBe(true);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await prepareEvidenceCapture(page);
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-skills-enabled.png"),
	});
	const useWithAgents = page.getByRole("button", { name: "Use with agents" });
	await useWithAgents.click();
	const targetDialog = page.getByRole("dialog", {
		name: "Use this skill with local agents",
	});
	await expect(targetDialog).toBeVisible();
	await page.getByRole("checkbox", { name: "Fixture Code Agent" }).click();
	await page.getByRole("button", { name: "Show all supported agents" }).click();
	const targetSearch = page.getByRole("searchbox", {
		name: "Search supported agents",
	});
	await targetSearch.fill("unavailable");
	await expect(
		page.getByRole("checkbox", { name: "Unavailable Fixture Agent" })
	).toBeDisabled();
	await expect(
		page.getByRole("checkbox", { name: "Fixture Code Agent" })
	).toHaveCount(0);
	await targetSearch.fill("");
	await expect(
		page.getByRole("checkbox", { name: "Fixture Code Agent" })
	).toHaveAttribute("aria-checked", "true");
	const rememberTargets = page.getByRole("checkbox", {
		name: "Remember for future skill installs",
	});
	await rememberTargets.click();
	await page.getByRole("button", { name: "Export", exact: true }).click();
	await expect(targetDialog).toHaveCount(0);
	expect(
		callsFor(
			fixture,
			"POST",
			`/api/skills/${encodeURIComponent(IDS.skillAlpha)}/distribute`
		).at(-1)?.body
	).toEqual({ rememberTargetIds: true, targetIds: ["fixture-code-agent"] });
	expect(fixture.skillTargetPreferences).toEqual({
		configured: true,
		targetIds: ["fixture-code-agent"],
		version: 1,
	});
	await useWithAgents.click();
	await expect(
		page.getByRole("checkbox", { name: "Fixture Code Agent" })
	).toHaveAttribute("aria-checked", "true");
	await expect(
		page.getByRole("checkbox", { name: "Remember for future skill installs" })
	).toHaveAttribute("aria-checked", "true");
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	expect(
		callsFor(
			fixture,
			"POST",
			`/api/skills/${encodeURIComponent(IDS.skillAlpha)}/distribute`
		)
	).toHaveLength(1);

	const editNavigation = page.evaluate(
		() =>
			new Promise<string>((resolveNavigation) => {
				window.addEventListener(
					"marketplace-store:tab",
					(event) => {
						const decode = window.__marketplaceHomeDecodeStringEvent;
						if (!decode) {
							throw new Error(
								"Marketplace Home event decoder is not installed"
							);
						}
						resolveNavigation(decode(event));
					},
					{ once: true }
				);
			})
	);
	await page.getByRole("button", { name: "Edit", exact: true }).click();
	expect(await editNavigation).toBe(`/skills/${IDS.skillAlpha}/edit`);
	await page.keyboard.press("Escape");
	await expect(page.getByRole("button", { name: "Close" })).toHaveCount(0);
	await page.getByRole("button", { name: /Get — 22 downloads/ }).click();
	await expect
		.poll(() => callsFor(fixture, "POST", "/api/skills/catalog/install").length)
		.toBe(3);
	expect(
		callsFor(fixture, "POST", "/api/skills/catalog/install").at(-1)?.body
	).toEqual({
		id: IDS.skill,
		promptForTargets: true,
		source: "fixture-skill-registry",
	});
	expect(fixture.skillInstalled.has(IDS.skill)).toBe(true);
	await page.getByRole("button", { name: "Close", exact: true }).click();
	const customSkillCard = page
		.locator("div.group.relative")
		.filter({ hasText: "custom helper" });
	const customSkillLike = customSkillCard.getByTestId("item-like-button");
	await customSkillLike.click();
	await expect(
		customSkillCard.getByRole("button", { name: "Unlike (3)" })
	).toHaveAttribute("aria-pressed", "true");
	expect(
		callsFor(fixture, "POST", "/api/marketplace/likes").at(-1)?.body
	).toEqual({
		namespace: IDS.skillCustom,
	});
	await customSkillCard.getByRole("button", { name: "Unlike (3)" }).click();
	expect(
		callsFor(fixture, "DELETE", "/api/marketplace/likes").at(-1)?.body
	).toEqual({
		namespace: IDS.skillCustom,
	});
	await customSkillCard.locator("button").first().click({ button: "right" });
	await page.getByRole("menuitem", { name: "Get" }).click();
	await expect
		.poll(() => callsFor(fixture, "POST", "/api/skills/catalog/install").length)
		.toBe(4);
	expect(
		callsFor(fixture, "POST", "/api/skills/catalog/install").at(-1)?.body
	).toEqual({
		id: IDS.skillCustom,
		promptForTargets: true,
		source: "fixture-custom-skills",
	});
	expect(fixture.skillInstalled.has(IDS.skillCustom)).toBe(true);
});

test("MCP catalog source, search, detail, and context install retry read back", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page);
	fixture.mcpInstallFailures = 2;
	await page.goto(`${STORY_URL}?section=mcp`);
	await expect(
		page.getByRole("button", { name: "Home MCP Fixture" })
	).toBeVisible();
	await page.getByRole("button", { name: "Source", exact: true }).click();
	await page.getByRole("combobox").first().click();
	await page.getByRole("option", { name: "Alternate MCP Registry" }).click();
	await expect(
		page.getByRole("button", { name: "Alternate MCP Fixture" })
	).toBeVisible();
	expect(
		callsFor(fixture, "POST", "/api/catalog/sources/select").at(-1)?.body
	).toEqual({
		id: "fixture-mcp-alt",
		kind: "mcp",
	});
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Alternate MCP Fixture" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Home MCP Fixture" })
	).toHaveCount(0);
	const alternateCard = page
		.getByRole("button", { name: "Alternate MCP Fixture" })
		.locator("xpath=..");
	await alternateCard.getByRole("button", { name: "Like (2)" }).click();
	await expect(
		alternateCard.getByRole("button", { name: "Unlike (3)" })
	).toHaveAttribute("aria-pressed", "true");
	expect(
		callsFor(fixture, "POST", "/api/marketplace/likes").at(-1)?.body
	).toEqual({
		namespace: `mcp:${IDS.mcpAlternate}`,
	});
	await alternateCard.getByRole("button", { name: "Unlike (3)" }).click();
	expect(
		callsFor(fixture, "DELETE", "/api/marketplace/likes").at(-1)?.body
	).toEqual({
		namespace: `mcp:${IDS.mcpAlternate}`,
	});

	await page.getByRole("button", { name: "Search", exact: true }).click();
	const search = page.getByPlaceholder("Search MCP servers…");
	await search.fill("alternate");
	await expect
		.poll(() =>
			callsFor(fixture, "GET", "/api/mcp/catalog").some(
				(call) => new URLSearchParams(call.search).get("query") === "alternate"
			)
		)
		.toBe(true);
	await expect(
		page.getByRole("button", { name: "Alternate MCP Fixture" })
	).toBeVisible();
	const searchRead = callsFor(fixture, "GET", "/api/mcp/catalog").at(-1);
	expect(new URLSearchParams(searchRead?.search).get("query")).toBe(
		"alternate"
	);
	await page.getByLabel("Clear search").click();
	await expect(
		page.getByRole("button", { name: "Alternate MCP Fixture" })
	).toBeVisible();
	await search.fill("no-such-mcp-fixture");
	await expect(page.getByText("No MCP servers found")).toBeVisible();
	await page.getByRole("button", { name: "Clear search" }).last().click();
	await expect(
		page.getByRole("button", { name: "Alternate MCP Fixture" })
	).toBeVisible();

	const server = page.getByRole("button", { name: "Alternate MCP Fixture" });
	await server.click();
	await expect
		.poll(() => {
			const detail = callsFor(fixture, "GET", "/api/mcp/catalog/detail").at(-1);
			return new URLSearchParams(detail?.search).get("id");
		})
		.toBe(IDS.mcpAlternate);
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await page.getByRole("button", { name: "Alternate MCP Fixture" }).click({
		button: "right",
	});
	await page.getByRole("menuitem", { name: "Get" }).click();
	const serverReadCountBeforeInstall = callsFor(
		fixture,
		"GET",
		"/api/mcp/servers"
	).length;
	await expect
		.poll(() => callsFor(fixture, "POST", "/api/mcp/catalog/install").length)
		.toBe(1);
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await page.getByRole("button", { name: "Get", exact: true }).click();
	await expect
		.poll(() => callsFor(fixture, "POST", "/api/mcp/catalog/install").length)
		.toBe(2);
	const detailAdd = page.getByRole("button", { name: "Add server" });
	await expect(detailAdd).toBeVisible();
	await detailAdd.click();
	await expect(page.getByText("Added", { exact: true }).first()).toBeVisible();
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Added", exact: true })
	).toBeDisabled();
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Alternate MCP Fixture" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Home MCP Fixture" })
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Added", exact: true })
	).toBeDisabled();
	expect(
		callsFor(fixture, "POST", "/api/mcp/catalog/install").map(
			(call) => call.body
		)
	).toEqual([
		{ force: false, id: IDS.mcpAlternate },
		{ force: false, id: IDS.mcpAlternate },
		{ force: false, id: IDS.mcpAlternate },
	]);
	expect(fixture.mcpInstalled.has(IDS.mcpAlternate)).toBe(true);
	await expect
		.poll(() => callsFor(fixture, "GET", "/api/mcp/servers").length)
		.toBeGreaterThan(serverReadCountBeforeInstall);
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-mcp-installed.png"),
	});
});

test("Apps and Plugins isolate their catalogs, retry browse, search, and persist unstable releases", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "apps");
	fixture.appCatalogFailures = 1;
	await page.reload();
	await expect(page.getByText(/Couldn't load apps/)).toBeVisible();
	const retryButton = page.getByRole("button", { name: "Try again" });
	await retryButton.click();
	await expect(
		page.getByText("Fixture Home App", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Fixture Home Plugin", { exact: true })
	).toHaveCount(0);
	const firstPartyReads = callsFor(
		fixture,
		"GET",
		"/api/plugins/catalog/browse"
	).filter((call) => !new URLSearchParams(call.search).has("origin"));
	expect(firstPartyReads.slice(-2).map((call) => call.search)).toEqual([
		"?limit=40&source=all",
		"?limit=40&source=all",
	]);
	await page.getByRole("button", { name: "Search", exact: true }).click();
	const search = page.getByPlaceholder("Search apps…");
	await search.fill("native");
	await expect(
		page.getByText("Fixture Home App", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Fixture Home Plugin", { exact: true })
	).toHaveCount(0);
	await expect
		.poll(() => {
			const read = callsFor(fixture, "GET", "/api/plugins/catalog/browse").find(
				(call) => new URLSearchParams(call.search).get("query") === "native"
			);
			return read?.search;
		})
		.toBe("?query=native&limit=40&source=all");
	await page.getByRole("button", { name: "Clear search" }).click();
	await expect(page.getByPlaceholder("Search apps…")).toHaveValue("");
	await expect(
		page.getByText("Fixture Home App", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Show more" }).click();
	await expect(
		page.getByText("Fixture Extra App 8", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Open Productivity" }).click();
	await expect(
		page.getByRole("heading", { name: "Productivity", exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Back to categories" }).click();
	await expect(
		page.getByRole("button", { name: "Open Productivity" })
	).toBeVisible();

	fixture.appCatalogFailures = 1;
	await page.goto(`${STORY_URL}?section=plugins`);
	await expect(page.getByText(/Couldn't load plugins/)).toBeVisible();
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(
		page.getByText("Fixture Home Plugin", { exact: true })
	).toBeVisible();
	const pluginReads = callsFor(
		fixture,
		"GET",
		"/api/plugins/catalog/browse"
	).filter((call) => {
		const params = new URLSearchParams(call.search);
		return !(
			params.has("origin") ||
			params.has("cursor") ||
			params.has("query")
		);
	});
	expect(pluginReads.slice(-2).map((call) => call.search)).toEqual([
		"?limit=40&source=all",
		"?limit=40&source=all",
	]);
	await expect(page.getByText("Fixture Home App", { exact: true })).toHaveCount(
		0
	);
	await expect(
		page.getByText("Beta Plugin Fixture", { exact: true })
	).toHaveCount(0);
	await page.getByRole("button", { name: "Filters" }).click();
	const browseReadsBeforeTag = callsFor(
		fixture,
		"GET",
		"/api/plugins/catalog/browse"
	).length;
	const tagSelect = page
		.getByText("Tag", { exact: true })
		.locator("..")
		.getByRole("combobox");
	await tagSelect.click();
	await page.getByRole("option", { name: "developer", exact: true }).click();
	await expect(
		page.getByText("Fixture Home Plugin", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("URL Installed Plugin", { exact: true })
	).toHaveCount(0);
	expect(callsFor(fixture, "GET", "/api/plugins/catalog/browse")).toHaveLength(
		browseReadsBeforeTag
	);
	await tagSelect.click();
	await page.getByRole("option", { name: "All tags", exact: true }).click();
	await expect(
		page.getByText("URL Installed Plugin", { exact: true })
	).toBeVisible();
	const showUnstable = page.getByRole("checkbox", {
		name: "Show unstable releases",
	});
	await showUnstable.check();
	await expect(
		page.getByText("Beta Plugin Fixture", { exact: true })
	).toBeVisible();
	await page.reload();
	await expect(
		page.getByText("Beta Plugin Fixture", { exact: true })
	).toBeVisible();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-plugins-unstable.png"),
	});
});

test("Plugins infinite scroll follows the exact next cursor after reaching the sentinel", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 620 });
	const fixture = await openStoreSection(page, "plugins");
	await page.getByRole("button", { name: "Search", exact: true }).click();
	await page.getByPlaceholder("Search plugins…").fill("paging-fixture");
	await expect(
		page.getByRole("button", { name: "Pagination Plugin 1", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Pagination Plugin 24", exact: true })
	).toBeVisible();
	const firstPage = callsFor(
		fixture,
		"GET",
		"/api/plugins/catalog/browse"
	).find(
		(call) =>
			new URLSearchParams(call.search).get("query") === "paging-fixture" &&
			!new URLSearchParams(call.search).has("cursor") &&
			!new URLSearchParams(call.search).has("origin")
	);
	expect(firstPage?.search).toBe("?query=paging-fixture&limit=40&source=all");
	await page
		.getByRole("button", { name: "Pagination Plugin 24", exact: true })
		.scrollIntoViewIfNeeded();
	await expect
		.poll(() => {
			const pageTwo = callsFor(
				fixture,
				"GET",
				"/api/plugins/catalog/browse"
			).find(
				(call) =>
					new URLSearchParams(call.search).get("cursor") === "fixture-next-page"
			);
			return pageTwo?.search;
		})
		.toBe("?query=paging-fixture&limit=40&cursor=fixture-next-page&source=all");
	await expect(
		page.getByRole("button", { name: "Pagination Plugin 25", exact: true })
	).toBeVisible();
});

test("Plugins source management and manifest URL install validate, retry, and read back local state", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "plugins");
	fixture.pluginSourceAddFailures = 1;
	fixture.appUrlInstallFailures = 1;
	await page.getByRole("button", { name: "Filters" }).click();
	const addMarketplaceButton = page
		.getByRole("button", {
			name: "Add marketplace",
			exact: true,
		})
		.first();
	await addMarketplaceButton.hover();
	const marketplaceTooltip = page.getByText("Add a Claude plugin marketplace", {
		exact: true,
	});
	await expect(marketplaceTooltip).toBeVisible();
	await expect(marketplaceTooltip).toHaveCSS("pointer-events", "none");
	await expect(marketplaceTooltip.locator("xpath=..")).toHaveCSS(
		"pointer-events",
		"none"
	);
	const catalogSource = page
		.getByText("Catalog source", { exact: true })
		.locator("..");
	const catalogSourcePicker = catalogSource.getByRole("combobox");
	await catalogSourcePicker.click();
	await page.getByRole("option", { name: "Fixture Plugin Source" }).click();
	await expect(catalogSourcePicker).toContainText("Fixture Plugin Source");
	await expect
		.poll(() =>
			callsFor(fixture, "GET", "/api/plugins/catalog/browse").some(
				(call) =>
					new URLSearchParams(call.search).get("source") ===
					"fixture-plugin-source"
			)
		)
		.toBe(true);
	expect(
		callsFor(fixture, "GET", "/api/plugins/catalog/browse").at(-1)?.search
	).toBe("?limit=40&source=fixture-plugin-source");

	await page.getByRole("button", { name: "Add marketplace" }).first().click();
	const repoField = page.getByLabel("Repo, git URL, or local path");
	const nameField = page.getByLabel("Display name (optional)");
	await page.getByRole("button", { name: "Add marketplace" }).last().click();
	await expect(
		page.getByText("Enter a repo, git URL, or local path")
	).toBeVisible();
	expect(callsFor(fixture, "POST", "/api/catalog/sources")).toHaveLength(0);
	await repoField.fill("  owner/fixture-marketplace  ");
	await nameField.fill("  Fixture Team  ");
	await page.getByRole("button", { name: "Add marketplace" }).last().click();
	await expect(page.getByText("Fixture source add failed")).toBeVisible();
	await expect(repoField).toHaveValue("  owner/fixture-marketplace  ");
	await page.getByRole("button", { name: "Add marketplace" }).last().click();
	await expect(repoField).toHaveCount(0);
	await page.getByRole("button", { name: "Add marketplace" }).click();
	await expect(repoField).toHaveValue("");
	await repoField.press("Escape");
	expect(
		callsFor(fixture, "POST", "/api/catalog/sources").map((call) => call.body)
	).toEqual([
		{
			base_url: "owner/fixture-marketplace",
			display_name: "Fixture Team",
			id: "mp-fixture-team",
			kind: "plugin",
		},
		{
			base_url: "owner/fixture-marketplace",
			display_name: "Fixture Team",
			id: "mp-fixture-team",
			kind: "plugin",
		},
	]);
	expect(fixture.pluginSources.at(-1)).toEqual({
		base_url: "owner/fixture-marketplace",
		builtin: false,
		display_name: "Fixture Team",
		id: "mp-fixture-team",
	});
	await catalogSourcePicker.click();
	await expect(
		page.getByRole("option", { name: "Fixture Team" })
	).toBeVisible();
	await page.getByRole("option", { name: "Fixture Team" }).click();
	await expect(catalogSourcePicker).toContainText("Fixture Team");
	await expect
		.poll(() =>
			callsFor(fixture, "GET", "/api/plugins/catalog/browse").some(
				(call) =>
					new URLSearchParams(call.search).get("source") === "mp-fixture-team"
			)
		)
		.toBe(true);

	const urlField = page.getByPlaceholder("https://…/manifest.json");
	await urlField.fill(
		"  https://github.com/fixture/url-plugin/manifest.json  "
	);
	await page.getByRole("button", { name: "Add from URL" }).click();
	await expect(urlField).toHaveValue(
		"  https://github.com/fixture/url-plugin/manifest.json  "
	);
	await expect(
		page.getByText("Gateway unreachable (fail-closed): gateway unreachable", {
			exact: true,
		})
	).toBeVisible();
	await urlField.press("Enter");
	await expect(urlField).toHaveValue("");
	expect(
		callsFor(fixture, "POST", "/api/plugins/install").map((call) => call.body)
	).toEqual([
		{ url: "https://github.com/fixture/url-plugin/manifest.json" },
		{ url: "https://github.com/fixture/url-plugin/manifest.json" },
	]);
	expect(fixture.appsInstalled.has(IDS.urlPlugin)).toBe(true);
	await expect
		.poll(() => callsFor(fixture, "GET", "/api/plugins").length)
		.toBeGreaterThan(0);
	await page.reload();
	await page
		.getByRole("button", { name: "Installed", exact: true })
		.first()
		.click();
	await expect(
		page.getByText("URL Installed Plugin", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Get", exact: true })
	).toHaveCount(0);
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-plugin-url-installed.png"),
	});
});

test("Apps install retries, consent gates enable, and enable/disable state reads back", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "apps");
	fixture.appInstallFailures = 1;
	const appCard = page
		.getByRole("button", { name: "Fixture Home App" })
		.locator("xpath=..");
	await appCard.getByRole("button", { name: "Get", exact: true }).click();
	const details = page.getByRole("dialog").first();
	await expect(details).toContainText("Fixture Home App");
	await expect(
		details.getByText(
			"Gateway unreachable (fail-closed): gateway unreachable",
			{
				exact: true,
			}
		)
	).toBeVisible();
	await details.getByRole("button", { name: "Get", exact: true }).click();
	await expect(
		details.getByRole("button", { name: "Enable", exact: true })
	).toBeVisible();
	expect(fixture.appsInstalled.has(IDS.app)).toBe(true);
	expect(
		callsFor(
			fixture,
			"POST",
			`/api/plugins/${encodeURIComponent(IDS.app)}/install`
		)
	).toHaveLength(2);
	await expect
		.poll(() => callsFor(fixture, "GET", "/api/plugins").length)
		.toBeGreaterThan(1);

	const enable = details.getByRole("button", { name: "Enable", exact: true });
	await enable.click();
	const consent = page.getByRole("alertdialog");
	await expect(consent).toContainText("Enable Fixture Home App?");
	await expect(consent).toContainText("Access the internet");
	await expect(consent).toContainText("Make network requests");
	await consent.getByRole("button", { name: "Cancel" }).click();
	expect(
		callsFor(
			fixture,
			"POST",
			`/api/plugins/${encodeURIComponent(IDS.app)}/enable`
		)
	).toHaveLength(0);

	await details.getByRole("button", { name: "Enable", exact: true }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Allow" })
		.click();
	await expect(
		details.getByRole("button", { name: "Disable", exact: true })
	).toBeVisible();
	expect(fixture.appEnabled.has(IDS.app)).toBe(true);
	expect(
		callsFor(
			fixture,
			"POST",
			`/api/plugins/${encodeURIComponent(IDS.app)}/enable`
		).map((call) => call.body)
	).toEqual([null]);

	await details.getByRole("button", { name: "Disable", exact: true }).click();
	await expect(
		details.getByRole("button", { name: "Enable", exact: true })
	).toBeVisible();
	expect(fixture.appEnabled.has(IDS.app)).toBe(false);
	expect(
		callsFor(
			fixture,
			"POST",
			`/api/plugins/${encodeURIComponent(IDS.app)}/disable`
		).map((call) => call.body)
	).toEqual([null]);
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-app-disabled-readback.png"),
	});
});

test("Plugins install and switch the exact release channel only after confirmation; Manage keeps enable gated", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "plugins");
	fixture.pluginInstallFailures = 1;
	await page.getByRole("button", { name: "Fixture Home Plugin" }).click();
	const details = page.getByRole("dialog").first();
	await expect(details).toContainText("Fixture Home Plugin");
	await expect
		.poll(
			() => callsFor(fixture, "GET", "/api/plugins/catalog/channels").length
		)
		.toBeGreaterThan(0);
	const installChannel = details.getByRole("combobox").first();
	await installChannel.click();
	await page.getByRole("option", { name: /Beta/ }).click();
	await details.getByRole("button", { name: "Get", exact: true }).click();
	await expect(
		details.getByText(
			"Gateway unreachable (fail-closed): gateway unreachable",
			{
				exact: true,
			}
		)
	).toBeVisible();
	await details.getByRole("button", { name: "Get", exact: true }).click();
	await expect(
		details.getByRole("button", { name: "Enable", exact: true })
	).toBeVisible();
	expect(fixture.appsInstalled.has(IDS.plugin)).toBe(true);
	expect(fixture.appChannels[IDS.plugin]).toBe("beta");
	expect(
		callsFor(fixture, "POST", "/api/plugins/catalog/install").map(
			(call) => call.body
		)
	).toEqual([
		{ channel: "beta", id: IDS.plugin },
		{ channel: "beta", id: IDS.plugin },
	]);

	const updatePath = `/api/plugins/${encodeURIComponent(IDS.plugin)}/update`;
	const channelPicker = details.getByRole("combobox").first();
	await channelPicker.click();
	await page.getByRole("option", { name: /Stable/ }).click();
	const switchDialog = page.getByRole("alertdialog");
	await expect(switchDialog).toContainText("Follow the Stable channel?");
	await switchDialog.getByRole("button", { name: "Cancel" }).click();
	expect(callsFor(fixture, "POST", updatePath)).toHaveLength(0);
	expect(fixture.appChannels[IDS.plugin]).toBe("beta");

	await channelPicker.click();
	await page.getByRole("option", { name: /Stable/ }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Switch" })
		.click();
	await expect.poll(() => fixture.appChannels[IDS.plugin]).toBe(null);
	expect(
		callsFor(fixture, "POST", updatePath).map((call) => call.body)
	).toEqual([{}]);
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-plugin-channel-readback.png"
		),
	});

	await details.getByRole("button", { name: "Close" }).click();
	const pluginCard = page
		.getByRole("button", { name: "Fixture Home Plugin" })
		.locator("xpath=..");
	await pluginCard.getByRole("button", { name: "Manage" }).click();
	const manageMenu = page.getByRole("menu", { name: "Manage" });
	await expect(
		manageMenu.getByRole("menuitem", { name: "Enable" })
	).toBeVisible();
	await expect(
		manageMenu.getByRole("menuitem", { name: "Remove" })
	).toHaveCount(0);
	await expect(
		manageMenu.getByRole("menuitem", { name: "Settings" })
	).toBeVisible();
	await expect(
		manageMenu.getByRole("menuitem", { name: "Report" })
	).toBeVisible();
	await manageMenu.getByRole("menuitem", { name: "Settings" }).click();
	await expect
		.poll(async () => {
			const effects = storeEffectsSchema.parse(
				JSON.parse(
					await page.getByTestId("marketplace-home-effects").innerText()
				)
			);
			return effects.openedSettings;
		})
		.toEqual([IDS.plugin]);

	await pluginCard.getByRole("button", { name: "Manage" }).click();
	await page.getByRole("menuitem", { name: "Report" }).click();
	const reportDialog = page.getByRole("dialog");
	await expect(reportDialog).toContainText("Report Fixture Home Plugin");
	await expect(
		reportDialog.getByRole("button", { name: "Submit report" })
	).toBeDisabled();
	await reportDialog.getByLabel("Reason").click();
	await page.getByRole("option", { name: "Something else" }).click();
	const reportDetails = reportDialog.getByLabel("Details (required)");
	await expect(reportDetails).toBeVisible();
	await expect(
		reportDialog.getByRole("button", { name: "Submit report" })
	).toBeDisabled();
	await reportDetails.fill("Fixture report draft");
	await reportDialog.getByRole("button", { name: "Cancel" }).click();
	const reportEffects = storeEffectsSchema.parse(
		JSON.parse(await page.getByTestId("marketplace-home-effects").innerText())
	);
	expect(reportEffects.submittedReports).toEqual([]);

	await pluginCard.getByRole("button", { name: "Manage" }).click();
	await page.getByRole("menuitem", { name: "Report" }).click();
	const reportDialogRetry = page.getByRole("dialog");
	await reportDialogRetry.getByLabel("Reason").click();
	await page.getByRole("option", { name: "Something else" }).click();
	await reportDialogRetry
		.getByLabel("Details (required)")
		.fill("Fixture report draft");
	await reportDialogRetry
		.getByRole("button", { name: "Submit report" })
		.click();
	await expect
		.poll(async () => {
			const effects = storeEffectsSchema.parse(
				JSON.parse(
					await page.getByTestId("marketplace-home-effects").innerText()
				)
			);
			return effects.submittedReports;
		})
		.toEqual([
			{
				details: "Fixture report draft",
				homepage: "https://github.com/fixture/ryu-plugin",
				id: IDS.plugin,
				installSource: "marketplace",
				itemName: "Fixture Home Plugin",
				kind: "plugin",
				reason: "other",
				source: "mongo",
			},
		]);
	await expect(reportDialogRetry).toHaveCount(0);

	await pluginCard.getByRole("button", { name: "Manage" }).click();
	const enableRequestsBeforeManage = callsFor(
		fixture,
		"POST",
		`/api/plugins/${encodeURIComponent(IDS.plugin)}/enable`
	).length;
	await manageMenu.getByRole("menuitem", { name: "Enable" }).click();
	await expect(page.getByRole("dialog").first()).toContainText(
		"Fixture Home Plugin"
	);
	await expect(
		callsFor(
			fixture,
			"POST",
			`/api/plugins/${encodeURIComponent(IDS.plugin)}/enable`
		)
	).toHaveLength(enableRequestsBeforeManage);
	expect(fixture.appsInstalled.has(IDS.plugin)).toBe(true);
});

test("Plugins detail tabs render safe docs, API, version snapshots, and confirmed exact historical install", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "plugins");
	await page.getByRole("button", { name: "Fixture Home Plugin" }).click();
	const details = page.getByRole("dialog").first();
	await expect(details).toContainText("Fixture Home Plugin");
	const readmeTab = details.getByRole("tab", { name: "README" });
	await readmeTab.click();
	await expect(
		details.getByText("Local README content for the Store detail proof.", {
			exact: true,
		})
	).toBeVisible();
	const originalReadme = details.getByRole("link", {
		name: "Read the original",
	});
	await expect(originalReadme).toHaveAttribute(
		"href",
		"https://github.com/fixture/ryu-plugin#readme"
	);
	await expect(originalReadme).toHaveAttribute("target", "_blank");
	await expect(originalReadme).toHaveAttribute("rel", "noopener noreferrer");
	const repository = details.locator(
		'a[href="https://github.com/fixture/ryu-plugin"]'
	);
	await expect(repository).toHaveAttribute("target", "_blank");
	await expect(repository).toHaveAttribute("rel", "noopener noreferrer");

	await details.getByRole("tab", { name: "API" }).click();
	await expect(
		details.getByText("Open fixture", { exact: true })
	).toBeVisible();
	await expect(
		details.getByText("fixture:open", { exact: true })
	).toBeVisible();
	await details.getByRole("tab", { name: "Dependencies" }).click();
	await expect(
		details.getByRole("heading", { name: "Requires these plugins" })
	).toBeVisible();
	await expect(
		details.getByText("fixture/required-plugin", { exact: true })
	).toBeVisible();
	await expect(details.getByText("≥ 1.2.0", { exact: true })).toBeVisible();
	await details.getByRole("button", { name: /Health .* out of 100/ }).click();
	await expect(details.getByRole("tab", { name: "Health" })).toHaveAttribute(
		"aria-selected",
		"true"
	);
	await expect(
		details.getByRole("heading", { name: "Automated checks" })
	).toBeVisible();
	fixture.auditFailures = 1;
	const auditButton = details.getByTestId("catalog-scan-button");
	await auditButton.click();
	await expect
		.poll(() => callsFor(fixture, "POST", "/api/catalog/scan").length)
		.toBe(1);
	await expect(
		details.getByText("Agent audit failed: Fixture audit unavailable", {
			exact: true,
		})
	).toBeVisible();
	expect(callsFor(fixture, "POST", "/api/catalog/scan")[0]?.body).toMatchObject(
		{
			description: "A signed fixture plugin for the Plugins tab.",
			execution: "agent",
			id: IDS.plugin,
			kind: "plugin",
			name: "Fixture Home Plugin",
			metadata: {
				repositoryUrl: "https://github.com/fixture/ryu-plugin",
				version: "1.0.0",
			},
		}
	);
	const auditGate = deferred();
	fixture.auditGate = auditGate;
	await auditButton.click();
	await expect
		.poll(() => callsFor(fixture, "POST", "/api/catalog/scan").length)
		.toBe(2);
	await expect(auditButton).toBeDisabled();
	await expect(
		details.getByText("The agent is reviewing the evidence…")
	).toBeVisible();
	auditGate.release();
	await expect(details.getByTestId("catalog-scan-result")).toContainText(
		"Local fixture audit result."
	);
	await details
		.getByRole("button", { name: "Open audit conversation" })
		.click();
	await expect
		.poll(async () => {
			const effects = storeEffectsSchema.parse(
				JSON.parse(
					await page.getByTestId("marketplace-home-effects").innerText()
				)
			);
			return effects.openedAuditConversations;
		})
		.toEqual(["fixture-audit-conversation"]);
	await details.getByRole("button", { name: "Audit again" }).click();
	await expect
		.poll(() => callsFor(fixture, "POST", "/api/catalog/scan").length)
		.toBe(3);
	await expect(details.getByTestId("catalog-scan-result")).toContainText(
		"Local fixture audit result."
	);

	const versionsTab = details.getByRole("tab", { name: "Versions" });
	if (await versionsTab.isVisible().catch(() => false)) {
		await versionsTab.click();
	} else {
		await details.getByRole("button", { name: /Show \d+ more tabs/ }).click();
		await page.getByRole("option", { name: /Reorder Versions/ }).click();
	}
	await expect(details.getByText("0.9.0", { exact: true })).toBeVisible();
	const releaseLink = details
		.getByRole("link", { name: "View release" })
		.last();
	await expect(releaseLink).toHaveAttribute(
		"href",
		"https://github.com/fixture/ryu-plugin/releases/tag/v0.9.0"
	);
	await expect(releaseLink).toHaveAttribute("target", "_blank");
	await expect(releaseLink).toHaveAttribute("rel", "noopener noreferrer");
	await details
		.getByRole("button", { name: "Show what shipped in this version" })
		.last()
		.click();
	await expect(details).toContainText("The historical fixture release.");
	await expect(details).toContainText("Licence: MIT");
	const snapshotRead = callsFor(
		fixture,
		"GET",
		"/api/plugins/catalog/version-detail"
	).at(-1);
	expect(new URLSearchParams(snapshotRead?.search).get("repo")).toBe(
		"https://github.com/fixture/ryu-plugin"
	);
	expect(new URLSearchParams(snapshotRead?.search).get("tag")).toBe("0.9.0");

	const installOldVersion = details.getByRole("button", {
		name: "Install 0.9.0",
	});
	await installOldVersion.click();
	const confirmation = page.getByRole("alertdialog");
	await expect(confirmation).toContainText("Install 0.9.0?");
	await confirmation.getByRole("button", { name: "Cancel" }).click();
	expect(
		callsFor(fixture, "POST", "/api/plugins/catalog/install")
	).toHaveLength(0);
	await installOldVersion.click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Install version" })
		.click();
	await expect(
		details.getByText("Installed 0.9.0", { exact: true })
	).toBeVisible();
	expect(
		callsFor(fixture, "POST", "/api/plugins/catalog/install").map(
			(call) => call.body
		)
	).toEqual([{ id: IDS.plugin, version: "0.9.0" }]);
	expect(fixture.appsInstalled.has(IDS.plugin)).toBe(true);
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-plugin-version-readback.png"
		),
	});
});

test("Plugins reviews validate, retry create and update, cancel edits, and delete with readback", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "plugins");
	await page.getByRole("button", { name: "Fixture Home Plugin" }).click();
	const details = page.getByRole("dialog").first();
	await details.getByRole("tab", { name: "Reviews" }).click();
	await expect(details.getByText("No reviews yet")).toBeVisible();
	await expect
		.poll(() => callsFor(fixture, "GET", "/api/marketplace/reviews").length)
		.toBeGreaterThan(0);
	const firstReviewRead = callsFor(
		fixture,
		"GET",
		"/api/marketplace/reviews"
	).at(-1);
	expect(new URLSearchParams(firstReviewRead?.search).get("id")).toBe(
		IDS.plugin
	);
	expect(new URLSearchParams(firstReviewRead?.search).get("kind")).toBe(
		"plugin"
	);
	expect(new URLSearchParams(firstReviewRead?.search).get("limit")).toBe("20");

	await details.getByRole("button", { name: "Write the first review" }).click();
	const post = details.getByRole("button", { name: "Post review" });
	await post.click();
	await expect(details.getByText("Pick a star rating first.")).toBeVisible();
	const rating = details.getByRole("radiogroup", { name: "Rating" });
	await rating.getByRole("button", { name: "5 stars" }).click();
	const title = details.getByLabel("Title (optional)");
	const body = details.getByLabel("Review (optional)");
	await title.fill("Fixture review title");
	await body.fill("Fixture review body");
	fixture.reviewWriteFailures = 1;
	await post.click();
	await expect(
		details.getByText("Fixture review write unavailable")
	).toBeVisible();
	await expect(title).toHaveValue("Fixture review title");
	await expect(body).toHaveValue("Fixture review body");
	await post.click();
	await expect(details.getByText("Your review", { exact: true })).toBeVisible();
	expect(
		callsFor(fixture, "POST", "/api/marketplace/reviews").map(
			(call) => call.body
		)
	).toEqual([
		{
			body: "Fixture review body",
			id: IDS.plugin,
			kind: "plugin",
			rating: 5,
			title: "Fixture review title",
		},
		{
			body: "Fixture review body",
			id: IDS.plugin,
			kind: "plugin",
			rating: 5,
			title: "Fixture review title",
		},
	]);
	expect(fixture.review).toMatchObject({
		body: "Fixture review body",
		rating: 5,
		title: "Fixture review title",
	});

	await title.fill("Unsubmitted title");
	await body.fill("Unsubmitted body");
	await rating.getByRole("button", { name: "2 stars" }).click();
	await details.getByRole("button", { name: "Cancel" }).click();
	await expect(title).toHaveValue("Fixture review title");
	await expect(body).toHaveValue("Fixture review body");
	await expect(rating.getByRole("button", { name: "5 stars" })).toHaveAttribute(
		"aria-checked",
		"true"
	);
	expect(callsFor(fixture, "POST", "/api/marketplace/reviews")).toHaveLength(2);

	await title.fill("Updated fixture title");
	await body.fill("Updated fixture body");
	await rating.getByRole("button", { name: "4 stars" }).click();
	fixture.reviewWriteFailures = 1;
	await details.getByRole("button", { name: "Update review" }).click();
	await expect(
		details.getByText("Fixture review write unavailable")
	).toBeVisible();
	await details.getByRole("button", { name: "Update review" }).click();
	await expect(title).toHaveValue("Updated fixture title");
	expect(fixture.review).toMatchObject({
		body: "Updated fixture body",
		rating: 4,
		title: "Updated fixture title",
	});
	expect(
		callsFor(fixture, "POST", "/api/marketplace/reviews")
			.slice(-2)
			.map((call) => call.body)
	).toEqual([
		{
			body: "Updated fixture body",
			id: IDS.plugin,
			kind: "plugin",
			rating: 4,
			title: "Updated fixture title",
		},
		{
			body: "Updated fixture body",
			id: IDS.plugin,
			kind: "plugin",
			rating: 4,
			title: "Updated fixture title",
		},
	]);
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-plugin-review-readback.png"),
	});

	fixture.reviewDeleteFailures = 1;
	await details.getByRole("button", { name: "Delete" }).click();
	await expect(
		details.getByText("Fixture review delete unavailable")
	).toBeVisible();
	expect(fixture.review).not.toBeNull();
	await details.getByRole("button", { name: "Delete" }).click();
	await expect(details.getByText("No reviews yet")).toBeVisible();
	expect(fixture.review).toBeNull();
	const deletes = callsFor(fixture, "DELETE", "/api/marketplace/reviews");
	expect(deletes).toHaveLength(2);
	expect(new URLSearchParams(deletes[0]?.search).get("id")).toBe(IDS.plugin);
	expect(new URLSearchParams(deletes[0]?.search).get("kind")).toBe("plugin");
});

test("Plugins Reviews Load more follows the exact local cursor and appends the next page", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "plugins");
	fixture.reviewExtraRows = Array.from({ length: 21 }, (_, index) => {
		const itemIndex = index + 1;
		return {
			body: `Fixture review body ${itemIndex}.`,
			createdAt: "2026-08-20T00:00:00Z",
			id: `fixture-review-${itemIndex}`,
			mine: false,
			rating: 5,
			title: `Fixture review title ${itemIndex}`,
			userName: `Fixture Reviewer ${itemIndex}`,
			verifiedPurchase: false,
		};
	});
	await page.getByRole("button", { name: "Fixture Home Plugin" }).click();
	const details = page.getByRole("dialog").first();
	await details.getByRole("tab", { name: "Reviews" }).click();
	await expect(
		details.getByText("Fixture review title 1", { exact: true })
	).toBeVisible();
	await expect(
		details.getByText("Fixture review title 20", { exact: true })
	).toBeVisible();
	await expect(
		details.getByText("Fixture review title 21", { exact: true })
	).toHaveCount(0);
	await details.getByRole("button", { name: "Load more reviews" }).click();
	await expect(
		details.getByText("Fixture review title 21", { exact: true })
	).toBeVisible();
	const reviewReads = callsFor(fixture, "GET", "/api/marketplace/reviews");
	const nextPageRead = reviewReads.at(-1);
	expect(new URLSearchParams(nextPageRead?.search).get("cursor")).toBe(
		"fixture-review-next"
	);
	expect(new URLSearchParams(nextPageRead?.search).get("id")).toBe(IDS.plugin);
	expect(new URLSearchParams(nextPageRead?.search).get("kind")).toBe("plugin");
	expect(new URLSearchParams(nextPageRead?.search).get("limit")).toBe("20");
});

test("Signed-out Reviews keeps reading available and captures Sign in to review handoff", async ({
	page,
}) => {
	await page.addInitScript(() => {
		window.localStorage.setItem(
			"fixture-marketplace-reviews-signed-out",
			"true"
		);
	});
	const fixture = await openStoreSection(page, "plugins");
	await page.getByRole("button", { name: "Fixture Home Plugin" }).click();
	const details = page.getByRole("dialog").first();
	await details.getByRole("tab", { name: "Reviews" }).click();
	await expect(details.getByText("No reviews yet")).toBeVisible();
	await expect(
		details.getByText("Sign in to write the first review.")
	).toBeVisible();
	await details.getByRole("button", { name: "Sign in to review" }).click();
	await expect
		.poll(async () => {
			const effects = storeEffectsSchema.parse(
				JSON.parse(
					await page.getByTestId("marketplace-home-effects").innerText()
				)
			);
			return effects.openedExternalUrls;
		})
		.toEqual(["https://fixture.invalid/login"]);
	expect(callsFor(fixture, "POST", "/api/marketplace/reviews")).toHaveLength(0);
});

test("Community Plugin direct Get shows a retryable failure and persists URL-based install", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "plugins");
	fixture.appUrlInstallFailures = 1;
	const communityCard = page
		.getByRole("button", { name: "Community Fixture Plugin" })
		.locator("xpath=..");
	await expect(
		page.getByText("Not reviewed by Ryu", { exact: true })
	).toBeVisible();
	await communityCard.getByRole("button", { name: "Like (2)" }).click();
	await expect(
		communityCard.getByRole("button", { name: "Unlike (3)" })
	).toHaveAttribute("aria-pressed", "true");
	await communityCard.getByRole("button", { name: "Unlike (3)" }).click();
	await expect(
		communityCard.getByRole("button", { name: "Like (2)" })
	).toHaveAttribute("aria-pressed", "false");
	expect(
		callsFor(fixture, "POST", "/api/marketplace/likes").at(-1)?.body
	).toEqual({ namespace: IDS.communityPlugin });
	expect(
		callsFor(fixture, "DELETE", "/api/marketplace/likes").at(-1)?.body
	).toEqual({ namespace: IDS.communityPlugin });
	await page.getByRole("button", { name: "Read the trust guidance" }).click();
	await expect
		.poll(async () => {
			const effects = storeEffectsSchema.parse(
				JSON.parse(
					await page.getByTestId("marketplace-home-effects").innerText()
				)
			);
			return effects.openedExternalUrls;
		})
		.toEqual(["https://docs.ryuhq.com/docs/security/trust-model"]);
	await communityCard.getByRole("button", { name: "Get", exact: true }).click();
	await expect(
		page.getByText("Gateway unreachable (fail-closed): gateway unreachable", {
			exact: true,
		})
	).toBeVisible();
	await expect(
		communityCard.getByRole("button", { name: "Get", exact: true })
	).toBeVisible();
	await communityCard.getByRole("button", { name: "Get", exact: true }).click();
	await expect(
		communityCard.getByRole("button", { name: "Installed", exact: true })
	).toBeDisabled();
	await expect(
		page.getByText("Not reviewed by Ryu", { exact: true })
	).toBeVisible();
	expect(fixture.appsInstalled.has(IDS.communityPlugin)).toBe(true);
	expect(
		callsFor(fixture, "POST", "/api/plugins/install").map((call) => call.body)
	).toEqual([
		{ url: "https://github.com/fixture/community-plugin" },
		{ url: "https://github.com/fixture/community-plugin" },
	]);
	await page.reload();
	const installedCommunityCard = page
		.getByRole("button", { name: "Community Fixture Plugin" })
		.locator("xpath=..");
	await expect(
		installedCommunityCard.getByRole("button", {
			name: "Installed",
			exact: true,
		})
	).toBeDisabled();
	await expect(
		installedCommunityCard.getByRole("button", { name: "Like (2)" })
	).toHaveAttribute("aria-pressed", "false");
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-community-plugin-installed.png"
		),
	});
});

test("Community preview Get installs from the selected repository URL", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "plugins");
	await page.getByRole("button", { name: "Community Fixture Plugin" }).click();
	const details = page.getByRole("dialog").first();
	await expect(details).toContainText("Not reviewed by Ryu");
	await details.getByRole("button", { name: "Get", exact: true }).click();
	await expect
		.poll(() => callsFor(fixture, "POST", "/api/plugins/install").length)
		.toBe(1);
	expect(
		callsFor(fixture, "POST", "/api/plugins/install").at(-1)?.body
	).toEqual({
		url: "https://github.com/fixture/community-plugin",
	});
	expect(
		callsFor(fixture, "POST", "/api/plugins/catalog/install")
	).toHaveLength(0);
	await expect(
		details.getByRole("button", { name: "Enable", exact: true })
	).toBeVisible();
	expect(fixture.appsInstalled.has(IDS.communityPlugin)).toBe(true);
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-community-preview-installed.png"
		),
	});
});

test("Plugins card likes persist and the right-click Get action retries the exact catalog install", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "plugins");
	const plugin = page.getByRole("button", { name: "Fixture Home Plugin" });
	const pluginCard = plugin.locator("xpath=..");
	await pluginCard.getByRole("button", { name: "Like (2)" }).click();
	await expect(
		pluginCard.getByRole("button", { name: "Unlike (3)" })
	).toHaveAttribute("aria-pressed", "true");
	expect(
		callsFor(fixture, "POST", "/api/marketplace/likes").at(-1)?.body
	).toEqual({ namespace: IDS.plugin });
	const batchReadsBeforeReload = callsFor(
		fixture,
		"POST",
		"/api/marketplace/likes/batch"
	).length;
	await page.reload();
	const persistedCard = page
		.getByRole("button", { name: "Fixture Home Plugin" })
		.locator("xpath=..");
	await expect(
		persistedCard.getByRole("button", { name: "Unlike (3)" })
	).toHaveAttribute("aria-pressed", "true");
	// The likes store coalesces reads per 16ms window, so the first-party and
	// community shelves may land in separate batches in either order; the
	// persisted heart must come from a post-reload read that named this plugin.
	expect(
		callsFor(fixture, "POST", "/api/marketplace/likes/batch")
			.slice(batchReadsBeforeReload)
			.map((call) => call.body)
	).toContainEqual(
		expect.objectContaining({
			namespaces: expect.arrayContaining([IDS.plugin]),
		})
	);

	fixture.pluginInstallFailures = 1;
	await page
		.getByRole("button", { name: "Fixture Home Plugin" })
		.click({ button: "right" });
	const contextGet = page.getByRole("menuitem", { name: "Get" });
	await expect(contextGet).toBeVisible();
	await contextGet.click();
	const details = page.getByRole("dialog").first();
	await expect(
		details.getByText(
			"Gateway unreachable (fail-closed): gateway unreachable",
			{
				exact: true,
			}
		)
	).toBeVisible();
	await details.getByRole("button", { name: "Get", exact: true }).click();
	await expect(
		details.getByRole("button", { name: "Enable", exact: true })
	).toBeVisible();
	expect(
		callsFor(fixture, "POST", "/api/plugins/catalog/install").map(
			(call) => call.body
		)
	).toEqual([{ id: IDS.plugin }, { id: IDS.plugin }]);
	expect(fixture.appsInstalled.has(IDS.plugin)).toBe(true);
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-plugin-context-installed.png"
		),
	});
});

test("Engine Try again reloads text, image, speech, and sandbox catalogs after a full list failure", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page);
	fixture.engineCatalogFailures = 2;
	fixture.sandboxListFailures = 1;
	await page.goto(`${STORY_URL}?section=engines`);
	await expect(page.getByRole("tab", { selected: true })).toContainText(
		"Engines"
	);
	await expect(page.getByText("Could not load engines")).toBeVisible();
	await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
	expect(callsFor(fixture, "GET", "/api/catalog")).toHaveLength(2);
	expect(callsFor(fixture, "GET", "/api/sandbox/backend")).toHaveLength(1);

	await page.getByRole("button", { name: "Try again" }).click();
	await expect(
		page.getByRole("heading", { name: "Text and Embedding" })
	).toBeVisible();
	await expect(page.getByRole("heading", { name: "Image" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Speech" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Sandboxes" })).toBeVisible();
	await expect(page.getByRole("button", { name: "llama.cpp" })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Pocket TTS Fixture" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Docker Fixture" })
	).toBeVisible();
	expect(callsFor(fixture, "GET", "/api/catalog")).toHaveLength(4);
	expect(callsFor(fixture, "GET", "/api/sandbox/backend")).toHaveLength(2);
});

test("Engines list groups and searches local runtime fixtures, and sandbox docs links stay safe", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	await expect(
		page.getByRole("heading", { name: "Text and Embedding" })
	).toBeVisible();
	await expect(page.getByRole("heading", { name: "Image" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Speech" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Sandboxes" })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "VLLM Unsupported Fixture" })
	).toBeVisible();
	const dockerCard = page
		.getByRole("button", { name: "Docker Fixture" })
		.locator("xpath=..");
	const dockerGuide = dockerCard.getByRole("link", { name: "How to install" });
	await expect(dockerGuide).toHaveAttribute(
		"href",
		"https://docs.docker.com/get-started/get-docker/"
	);
	await expect(dockerGuide).toHaveAttribute("target", "_blank");
	await expect(dockerGuide).toHaveAttribute("rel", "noopener noreferrer");

	await page.getByRole("button", { name: "Search", exact: true }).click();
	const search = page.getByPlaceholder("Search engines…");
	await search.fill("pocket");
	await expect(
		page.getByRole("button", { name: "Pocket TTS Fixture" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Ollama Fixture" })
	).toHaveCount(0);
	await search.fill("no-such-engine");
	await expect(page.getByText("No engines found")).toBeVisible();
	const clearActions = page.getByRole("button", { name: "Clear search" });
	await expect(clearActions).toHaveCount(2);
	await clearActions.last().click();
	await expect(search).toHaveValue("");
	await expect(
		page.getByRole("button", { name: "Ollama Fixture" })
	).toBeVisible();
	await search.press("Escape");
	await expect(search).toHaveAttribute("aria-hidden", "true");
	await page.getByRole("button", { name: "Search", exact: true }).click();
	await expect(search).toHaveAttribute("aria-hidden", "false");
	await search.fill("no-such-engine");
	await expect(page.getByText("No engines found")).toBeVisible();
	await page.getByLabel("Clear search").click();
	await expect(search).toHaveValue("");
	await expect(search).toHaveAttribute("aria-hidden", "true");
	await expect(page.getByText("No engines found")).toHaveCount(0);
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-engines-catalog.png"),
	});
	expect(callsFor(fixture, "GET", "/api/catalog").length).toBeGreaterThan(0);
});

test("Installed engine card menus activate and remove the exact local engine", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	fixture.engineActionFailures[`${IDS.engineNew}:install`] = 1;
	const koboldCard = page
		.getByRole("button", { name: "KoboldCPP Fixture" })
		.locator("xpath=..");
	await koboldCard.getByRole("button", { name: "Get", exact: true }).click();
	await expect(
		koboldCard.getByText("Fixture install failed", { exact: true })
	).toBeVisible();
	expect(fixture.engineInstalled.has(IDS.engineNew)).toBe(false);
	await page
		.getByRole("button", { name: "KoboldCPP Fixture" })
		.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Get" }).click();
	await expect(
		koboldCard.getByRole("button", { name: "Installed" })
	).toBeVisible();
	await page.reload();

	const installedKoboldCard = page
		.getByRole("button", { name: "KoboldCPP Fixture" })
		.locator("xpath=..");
	await installedKoboldCard.getByRole("button", { name: "Manage" }).click();
	await page.getByRole("menuitem", { name: "Set as active" }).click();
	await expect.poll(() => fixture.engineActive).toBe(IDS.engineNew);

	await page
		.getByRole("button", { name: "Ollama Fixture" })
		.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Set as active" }).click();
	await expect.poll(() => fixture.engineActive).toBe(IDS.engineUpdate);

	await page
		.getByRole("button", { name: "KoboldCPP Fixture" })
		.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Remove" }).click();
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
	await expect
		.poll(() => fixture.engineInstalled.has(IDS.engineNew))
		.toBe(false);
	await expect(
		page
			.getByRole("button", { name: "KoboldCPP Fixture" })
			.locator("xpath=..")
			.getByRole("button", { name: "Get" })
	).toBeVisible();
	expect(
		callsFor(fixture, "POST", "/api/engine/active").map((call) => call.body)
	).toEqual([{ name: IDS.engineNew }, { name: IDS.engineUpdate }]);
	expect(
		callsFor(fixture, "POST", `/api/setup/${IDS.engineNew}/install`).map(
			(call) => ({ search: call.search, body: call.body })
		)
	).toEqual([
		{ search: "", body: null },
		{ search: "", body: null },
	]);
	expect(
		callsFor(fixture, "POST", `/api/setup/${IDS.engineNew}/uninstall`).map(
			(call) => call.body
		)
	).toEqual([null]);
	await page.reload();
	await expect(
		page
			.getByRole("button", { name: "KoboldCPP Fixture" })
			.locator("xpath=..")
			.getByRole("button", { name: "Get" })
	).toBeVisible();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-engine-card-actions.png"),
	});
});

test("Engine update and Remove retry exact sidecar requests and read installed state back", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	fixture.engineActionFailures[`${IDS.engineUpdate}:install`] = 1;
	await page.getByRole("button", { name: "Ollama Fixture" }).click();
	const details = page.getByRole("dialog").first();
	await expect(details).toContainText("Ollama Fixture");
	const update = details.getByRole("button", { name: "Update" });
	await update.click();
	await expect(details.getByText("Fixture install failed")).toBeVisible();
	await update.click();
	await expect(details.getByRole("button", { name: "Update" })).toHaveCount(0);
	expect(fixture.engineInstalledVersions[IDS.engineUpdate]).toBe("0.3.0");
	expect(
		callsFor(fixture, "POST", `/api/setup/${IDS.engineUpdate}/install`).map(
			(call) => call.search
		)
	).toEqual(["?force=true", "?force=true"]);

	fixture.engineActionFailures[`${IDS.engineUpdate}:uninstall`] = 1;
	const remove = details.getByRole("button", { name: "Remove" });
	await remove.click();
	await expect(details.getByText("Fixture uninstall failed")).toBeVisible();
	expect(fixture.engineInstalled.has(IDS.engineUpdate)).toBe(true);
	const removeGate = deferred();
	fixture.engineActionGates[`${IDS.engineUpdate}:uninstall`] = removeGate;
	await remove.click();
	await expect
		.poll(
			() =>
				callsFor(fixture, "POST", `/api/setup/${IDS.engineUpdate}/uninstall`)
					.length
		)
		.toBe(2);
	await expect(remove).toBeDisabled();
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
	removeGate.release();
	await expect(
		details.getByRole("button", { name: "Add", exact: true })
	).toBeVisible();
	expect(fixture.engineInstalled.has(IDS.engineUpdate)).toBe(false);
	expect(
		callsFor(fixture, "POST", `/api/setup/${IDS.engineUpdate}/uninstall`).map(
			(call) => call.body
		)
	).toEqual([null, null]);
});

test("Engine cards install locally and their active switch only swaps to another resident engine", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	const activeEngine = page.getByRole("button", { name: "llama.cpp" });
	await activeEngine.click();
	const activeSwitch = page.getByRole("switch", {
		name: "Set llama.cpp as active engine",
	});
	await expect(activeSwitch).toBeChecked();
	await expect(activeSwitch).toBeDisabled();
	expect(callsFor(fixture, "POST", "/api/engine/active")).toHaveLength(0);
	await page.getByRole("button", { name: "Close", exact: true }).click();

	const newEngineCard = page
		.getByRole("button", { name: "KoboldCPP Fixture" })
		.locator("xpath=..");
	await newEngineCard.getByRole("button", { name: "Get", exact: true }).click();
	await expect(
		newEngineCard.getByRole("button", { name: "Installed" })
	).toBeVisible();
	expect(fixture.engineInstalled.has(IDS.engineNew)).toBe(true);
	expect(
		callsFor(fixture, "POST", `/api/setup/${IDS.engineNew}/install`).map(
			(call) => ({ search: call.search, body: call.body })
		)
	).toEqual([{ search: "", body: null }]);

	await page.reload();
	await page.getByRole("button", { name: "KoboldCPP Fixture" }).click();
	await expect(
		page.getByRole("switch", {
			name: "Set KoboldCPP Fixture as active engine",
		})
	).toBeEnabled();
	fixture.engineActionFailures[`${IDS.engineNew}:activate`] = 1;
	fixture.engineGatewayRefreshed = false;
	const koboldSwitch = page.getByRole("switch", {
		name: "Set KoboldCPP Fixture as active engine",
	});
	await koboldSwitch.click();
	const detail = page
		.getByRole("dialog")
		.getByText("/api/engine/active failed: 503", { exact: true });
	await expect(detail).toBeVisible();
	await koboldSwitch.click();
	await expect(koboldSwitch).toBeChecked();
	await expect(
		page.getByText("Engine active, but gateway routing was not refreshed.")
	).toBeVisible();
	expect(fixture.engineActive).toBe(IDS.engineNew);
	expect(
		callsFor(fixture, "POST", "/api/engine/active").map((call) => call.body)
	).toEqual([{ name: IDS.engineNew }, { name: IDS.engineNew }]);
	await page.reload();
	await page.getByRole("button", { name: "KoboldCPP Fixture" }).click();
	await expect(
		page.getByRole("switch", {
			name: "Set KoboldCPP Fixture as active engine",
		})
	).toBeChecked();
	await expect(
		page.getByText("Engine active, but gateway routing was not refreshed.")
	).toHaveCount(0);
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-engine-active-readback.png"),
	});
});

test("Image and speech sidecar switches retry start and stop, and running engines cannot be removed", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	await page
		.getByRole("button", { name: "Stable Diffusion CPP Fixture" })
		.click();
	const sidecarSwitch = page.getByRole("switch", {
		name: "Start or stop Stable Diffusion CPP Fixture",
	});
	await expect(sidecarSwitch).not.toBeChecked();
	fixture.engineActionFailures[`${IDS.mediaEngine}:start`] = 1;
	await sidecarSwitch.click();
	await expect(
		page.getByRole("dialog").getByText("Fixture start failed", { exact: true })
	).toBeVisible();
	await expect(sidecarSwitch).not.toBeChecked();
	const startGate = deferred();
	fixture.engineActionGates[`${IDS.mediaEngine}:start`] = startGate;
	await sidecarSwitch.click();
	await expect
		.poll(
			() =>
				callsFor(fixture, "POST", `/api/sidecar/${IDS.mediaEngine}/start`)
					.length
		)
		.toBe(2);
	await expect(sidecarSwitch).toBeDisabled();
	startGate.release();
	await expect(sidecarSwitch).toBeChecked();
	await expect(page.getByRole("button", { name: "Remove" })).toBeDisabled();
	expect(fixture.engineRunning[IDS.mediaEngine]).toBe(true);

	fixture.engineActionFailures[`${IDS.mediaEngine}:stop`] = 1;
	await sidecarSwitch.click();
	await expect(
		page.getByRole("dialog").getByText("Fixture stop failed", { exact: true })
	).toBeVisible();
	await expect(sidecarSwitch).toBeChecked();
	await sidecarSwitch.click();
	await expect(sidecarSwitch).not.toBeChecked();
	await expect(page.getByRole("button", { name: "Remove" })).toBeEnabled();
	expect(fixture.engineRunning[IDS.mediaEngine]).toBe(false);
	expect(
		callsFor(fixture, "POST", `/api/sidecar/${IDS.mediaEngine}/start`).map(
			(call) => call.body
		)
	).toEqual([null, null]);
	expect(
		callsFor(fixture, "POST", `/api/sidecar/${IDS.mediaEngine}/stop`).map(
			(call) => call.body
		)
	).toEqual([null, null]);
	await page.reload();
	await page
		.getByRole("button", { name: "Stable Diffusion CPP Fixture" })
		.click();
	await expect(
		page.getByRole("switch", {
			name: "Start or stop Stable Diffusion CPP Fixture",
		})
	).not.toBeChecked();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-engine-sidecar-stopped.png"),
	});
});

test("Image sidecar Add retries the exact local install and reads its installed state back", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	fixture.engineActionFailures[`${IDS.mediaNew}:install`] = 1;
	const sidecarCard = page
		.getByRole("button", { name: "Image Sidecar Candidate" })
		.locator("xpath=..");
	await sidecarCard.getByRole("button", { name: "Get" }).click();
	await expect(
		sidecarCard.getByText("Fixture install failed", { exact: true })
	).toBeVisible();
	expect(fixture.engineInstalled.has(IDS.mediaNew)).toBe(false);

	await page.getByRole("button", { name: "Image Sidecar Candidate" }).click();
	const details = page.getByRole("dialog").first();
	await expect(details).toContainText("Image Sidecar Candidate");
	await details.getByRole("button", { name: "Add", exact: true }).click();
	await expect(
		details.getByRole("button", { name: "Remove", exact: true })
	).toBeVisible();
	expect(fixture.engineInstalled.has(IDS.mediaNew)).toBe(true);
	expect(
		callsFor(fixture, "POST", `/api/setup/${IDS.mediaNew}/install`).map(
			(call) => ({ search: call.search, body: call.body })
		)
	).toEqual([
		{ search: "", body: null },
		{ search: "", body: null },
	]);
	await page.reload();
	await page.getByRole("button", { name: "Image Sidecar Candidate" }).click();
	await expect(
		page.getByRole("switch", {
			name: "Start or stop Image Sidecar Candidate",
		})
	).toBeEnabled();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-engine-sidecar-installed.png"
		),
	});
});

test("Engine card Manage and context actions open settings and recover sidecar failures", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	fixture.engineActionFailures[`${IDS.voiceEngine}:stop`] = 1;
	const voiceCard = page
		.getByRole("button", { name: "Pocket TTS Fixture" })
		.locator("xpath=..");
	await voiceCard.getByRole("button", { name: "Manage" }).click();
	await expect(page.getByRole("menuitem", { name: "Settings" })).toBeVisible();
	await expect(page.getByRole("menuitem", { name: "Stop" })).toBeVisible();
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-engine-manage-settings-stop.png"
		),
	});
	await page.getByRole("menuitem", { name: "Settings" }).click();
	await expect
		.poll(async () => {
			const effects = storeEffectsSchema.parse(
				JSON.parse(
					await page.getByTestId("marketplace-home-effects").innerText()
				)
			);
			return effects.openedSettings;
		})
		.toEqual([IDS.voiceEngine]);

	await voiceCard.getByRole("button", { name: "Manage" }).click();
	await page.getByRole("menuitem", { name: "Stop" }).click();
	await expect(
		page.getByText("Fixture stop failed", { exact: true })
	).toBeVisible();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-engine-card-error.png"),
	});
	expect(fixture.engineRunning[IDS.voiceEngine]).toBe(true);
	await voiceCard.getByRole("button", { name: "Manage" }).click();
	await page.getByRole("menuitem", { name: "Stop" }).click();
	await expect.poll(() => fixture.engineRunning[IDS.voiceEngine]).toBe(false);

	await page
		.getByRole("button", { name: "Pocket TTS Fixture" })
		.click({ button: "right" });
	await expect(page.getByRole("menuitem", { name: "Start" })).toBeVisible();
	await expect(page.getByRole("menuitem", { name: "Remove" })).toBeVisible();
	await page.getByRole("menuitem", { name: "Settings" }).click();
	await expect
		.poll(async () => {
			const effects = storeEffectsSchema.parse(
				JSON.parse(
					await page.getByTestId("marketplace-home-effects").innerText()
				)
			);
			return effects.openedSettings;
		})
		.toEqual([IDS.voiceEngine, IDS.voiceEngine]);
	await page
		.getByRole("button", { name: "Pocket TTS Fixture" })
		.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Start" }).click();
	await expect.poll(() => fixture.engineRunning[IDS.voiceEngine]).toBe(true);
	expect(
		callsFor(fixture, "POST", `/api/sidecar/${IDS.voiceEngine}/stop`).map(
			(call) => call.body
		)
	).toEqual([null, null]);
	expect(
		callsFor(fixture, "POST", `/api/sidecar/${IDS.voiceEngine}/start`).map(
			(call) => call.body
		)
	).toEqual([null]);
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Pocket TTS Fixture" }).locator("xpath=..")
	).toContainText("Installed");
});

test("Sandbox default selection retries the exact backend and unsupported/default controls stay disabled", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	await page.getByRole("button", { name: "WasmTime Fixture" }).click();
	await expect(
		page.getByRole("switch", {
			name: "Set WasmTime Fixture as the default sandbox backend",
		})
	).toBeDisabled();
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await page.getByRole("button", { name: "OpenSandbox Fixture" }).click();
	await expect(
		page.getByRole("switch", {
			name: "Set OpenSandbox Fixture as the default sandbox backend",
		})
	).toBeDisabled();
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await page.getByRole("button", { name: "Docker Fixture" }).click();
	const defaultSwitch = page.getByRole("switch", {
		name: "Set Docker Fixture as the default sandbox backend",
	});
	fixture.sandboxSetFailures = 1;
	await defaultSwitch.click();
	await expect(
		page
			.getByRole("dialog")
			.getByText("/api/sandbox/backend failed: 503", { exact: true })
	).toBeVisible();
	const gate = deferred();
	fixture.sandboxSetGate = gate;
	await defaultSwitch.click();
	await expect
		.poll(() => callsFor(fixture, "POST", "/api/sandbox/backend").length)
		.toBe(2);
	await expect(defaultSwitch).toBeDisabled();
	gate.release();
	await expect(defaultSwitch).toBeChecked();
	expect(fixture.sandboxDefault).toBe("docker");
	expect(
		callsFor(fixture, "POST", "/api/sandbox/backend").map((call) => call.body)
	).toEqual([{ name: "docker" }, { name: "docker" }]);
	await page.reload();
	await page.getByRole("button", { name: "Docker Fixture" }).click();
	await expect(
		page.getByRole("switch", {
			name: "Set Docker Fixture as the default sandbox backend",
		})
	).toBeChecked();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-sandbox-default-readback.png"
		),
	});
});

test("llama.cpp acceleration selection reports failure, locks while switching, and reads back the exact build", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	await page.getByRole("button", { name: "llama.cpp" }).click();
	const auto = page.getByRole("radio", { name: /Automatic/ });
	const metal = page.getByRole("radio", { name: "Metal" });
	const cuda = page.getByRole("radio", { name: "CUDA" });
	await expect(auto).toBeChecked();
	await expect(metal).toBeEnabled();
	await expect(cuda).toBeDisabled();
	fixture.accelerationFailures = 1;
	await metal.click();
	await expect(
		page.getByText("/api/engine/llamacpp/acceleration failed: 503", {
			exact: true,
		})
	).toBeVisible();
	await expect(auto).toBeChecked();
	const gate = deferred();
	fixture.accelerationGate = gate;
	await metal.click();
	await expect(
		page.getByText("Downloading and switching the build…", { exact: true })
	).toBeVisible();
	await expect(auto).toBeDisabled();
	await expect(metal).toBeDisabled();
	gate.release();
	await expect(metal).toBeChecked();
	await expect(
		page.getByText("Right now this engine runs on Metal.")
	).toBeVisible();
	expect(fixture.acceleration.selected).toBe("metal");
	expect(
		callsFor(fixture, "POST", "/api/engine/llamacpp/acceleration").map(
			(call) => call.body
		)
	).toEqual([{ variant: "metal" }, { variant: "metal" }]);
	await page.reload();
	await page.getByRole("button", { name: "llama.cpp" }).click();
	await expect(page.getByRole("radio", { name: "Metal" })).toBeChecked();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-engine-acceleration-readback.png"
		),
	});
});

test("engine detail saves shared sampling and launch defaults", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	await page.getByRole("button", { name: "llama.cpp" }).click();
	await expect(
		page.getByRole("heading", { name: "Advanced configuration" })
	).toBeVisible();

	await page
		.getByRole("button", { name: "Sampling defaults", exact: true })
		.click({ force: true });
	await page.getByRole("spinbutton", { name: "Temperature" }).fill("0.4");
	await page.getByRole("button", { name: "Save sampling defaults" }).click();
	await expect(page.getByText("Saved for this engine")).toBeVisible();

	const launchSections = page.getByRole("region", {
		name: "Engine launch defaults",
	});
	await expect(launchSections).toHaveCount(2);
	const chatLaunchSection = launchSections.nth(0);
	await chatLaunchSection
		.getByRole("button", { name: "Engine launch settings" })
		.click();
	await chatLaunchSection
		.getByRole("spinbutton", { name: "Context size" })
		.fill("4096");
	await chatLaunchSection
		.getByRole("spinbutton", { name: "Unload after idle (seconds)" })
		.fill("120");
	await chatLaunchSection
		.getByRole("button", { name: "Save engine launch settings" })
		.click();
	await expect(page.getByText("Saved", { exact: true })).toBeVisible();

	const embeddingLaunchSection = launchSections.nth(1);
	await embeddingLaunchSection
		.getByRole("button", { name: "Engine launch settings" })
		.click();
	await embeddingLaunchSection
		.getByRole("spinbutton", { name: "Context size" })
		.fill("6144");
	await embeddingLaunchSection
		.getByRole("button", { name: "Save engine launch settings" })
		.click();
	await expect(page.getByText("Saved", { exact: true }).last()).toBeVisible();

	expect(
		callsFor(fixture, "PUT", "/api/preferences/inference.engine.llamacpp").map(
			(call) => call.body
		)
	).toEqual([{ value: JSON.stringify({ temperature: 0.4 }) }]);
	expect(
		callsFor(
			fixture,
			"PUT",
			"/api/preferences/model.launch.engine.llamacpp"
		).map((call) => call.body)
	).toEqual([
		{
			value: JSON.stringify({ ctx_size: 4096, sleep_idle_secs: 120 }),
		},
	]);
	expect(
		callsFor(
			fixture,
			"PUT",
			"/api/preferences/model.launch.engine.llamacpp-embed"
		).map((call) => call.body)
	).toEqual([{ value: JSON.stringify({ ctx_size: 6144 }) }]);

	await page
		.getByRole("heading", { name: "Advanced configuration" })
		.scrollIntoViewIfNeeded();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-engine-advanced-settings.png"
		),
	});
	await embeddingLaunchSection
		.getByRole("button", {
			name: "Engine launch settings",
			exact: true,
		})
		.scrollIntoViewIfNeeded();
	await prepareEvidenceCapture(page);
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-engine-embedding-launch-settings.png"
		),
	});
});

test("every chat runtime has its own engine-wide settings", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	const chatEngineIds = new Set([
		"llamacpp",
		"ollama",
		"koboldcpp",
		"vllm",
		"sglang",
		"mlx",
		"mlx-vlm",
		"mlx-serve",
		"omlx",
		"lemonade",
		"llama-swap",
		"freetoken",
		"docker-model-runner",
		"apfel",
		"mesh-llm",
	]);
	const manualLaunchProfileIds = new Set([
		"koboldcpp",
		"lemonade",
		"llama-swap",
		"freetoken",
		"docker-model-runner",
	]);
	const chatEngines = engineCatalogItems(fixture).filter((engine) =>
		chatEngineIds.has(engine.name)
	);
	expect(chatEngines.map((engine) => engine.name).sort()).toEqual(
		[...chatEngineIds].sort()
	);

	for (const engine of chatEngines) {
		await page.getByRole("button", { name: engine.display_name }).click();
		await expect(
			page.getByRole("heading", { name: "Advanced configuration" })
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Engine launch settings" }).first()
		).toBeVisible();
		await page
			.getByRole("button", { name: "Sampling defaults", exact: true })
			.click({ force: true });
		await page.getByRole("spinbutton", { name: "Temperature" }).fill("0.35");
		await page.getByRole("button", { name: "Save sampling defaults" }).click();
		await expect(page.getByText("Saved for this engine")).toBeVisible();
		expect(
			callsFor(
				fixture,
				"PUT",
				`/api/preferences/inference.engine.${engine.name}`
			).map((call) => call.body)
		).toEqual([{ value: JSON.stringify({ temperature: 0.35 }) }]);
		if (engine.name === "lemonade") {
			await page
				.getByRole("textbox", { name: "Extra body fields (JSON)" })
				.fill('{"top_k": 23}');
			await page
				.getByRole("button", { name: "Save sampling defaults" })
				.click();
			await expect(page.getByText("Saved for this engine")).toBeVisible();
			expect(
				callsFor(
					fixture,
					"PUT",
					"/api/preferences/inference.engine.lemonade"
				).map((call) => call.body)
			).toEqual([
				{ value: JSON.stringify({ temperature: 0.35 }) },
				{
					value: JSON.stringify({ temperature: 0.35, extra: { top_k: 23 } }),
				},
			]);
		}
		if (manualLaunchProfileIds.has(engine.name)) {
			await page
				.getByRole("button", { name: "Engine launch settings" })
				.first()
				.click();
			await expect(page.getByText(/saved copy only/i)).toBeVisible();
			await page
				.getByRole("textbox", { name: "Runtime args" })
				.fill(`--engine-id, ${engine.name}`);
			await page
				.getByRole("button", { name: "Save engine launch settings" })
				.click();
			await expect(page.getByText("Saved", { exact: true })).toBeVisible();
			expect(
				callsFor(
					fixture,
					"PUT",
					`/api/preferences/model.launch.engine.${engine.name}`
				).map((call) => call.body)
			).toEqual([
				{
					value: JSON.stringify({
						extra_args: ["--engine-id", engine.name],
					}),
				},
			]);
			await expect(
				page.getByRole("textbox", { name: "Runtime args" })
			).toBeVisible();
		} else {
			await page
				.getByRole("button", { name: "Engine launch settings" })
				.first()
				.click();
			if (["llamacpp", "ollama", "vllm", "sglang"].includes(engine.name)) {
				await expect(
					page.getByRole("spinbutton", { name: "Context size" })
				).toBeVisible();
			} else {
				await expect(
					page.getByRole("textbox", { name: "Extra args" })
				).toBeVisible();
			}
		}
		await page.getByRole("button", { name: "Close", exact: true }).click();
	}
});

test("Ollama exposes a copyable per-engine Modelfile profile", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	await page.getByRole("button", { name: "Ollama Fixture" }).click();
	await page
		.getByRole("button", { name: "Sampling defaults", exact: true })
		.click();
	await page.getByRole("spinbutton", { name: "Top K" }).fill("40");
	await page.getByRole("button", { name: "Save sampling defaults" }).click();
	await expect(page.getByText("Saved for this engine")).toBeVisible();
	await page.getByRole("button", { name: "Engine launch settings" }).click();
	await expect(
		page.getByText(/does not create a derived Ollama model/i)
	).toBeVisible();
	await page.getByRole("spinbutton", { name: "Context size" }).fill("8192");
	await page.getByRole("spinbutton", { name: "Batch size" }).fill("256");
	await expect(page.getByLabel("Generated Ollama Modelfile")).toContainText(
		"PARAMETER num_ctx 8192"
	);
	await expect(page.getByLabel("Generated Ollama Modelfile")).toContainText(
		"PARAMETER num_batch 256"
	);
	await expect(page.getByLabel("Generated Ollama Modelfile")).toContainText(
		"PARAMETER top_k 40"
	);
	await page
		.getByRole("button", { name: "Save engine launch settings" })
		.click();
	await expect(page.getByText("Saved", { exact: true })).toBeVisible();
	expect(
		callsFor(fixture, "PUT", "/api/preferences/inference.engine.ollama").map(
			(call) => call.body
		)
	).toEqual([{ value: JSON.stringify({ top_k: 40 }) }]);
	expect(
		callsFor(fixture, "PUT", "/api/preferences/model.launch.engine.ollama").map(
			(call) => call.body
		)
	).toEqual([
		{
			value: JSON.stringify({
				ctx_size: 8192,
				batch_size: 256,
			}),
		},
	]);

	await page.getByLabel("Generated Ollama Modelfile").scrollIntoViewIfNeeded();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-ollama-modelfile-settings.png"
		),
	});
});

test("chat engines without a launch adapter expose a saved runtime profile", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	await page.getByRole("button", { name: "KoboldCPP Fixture" }).click();
	await page.getByRole("button", { name: "Engine launch settings" }).click();
	await expect(page.getByText(/saved copy only/i)).toBeVisible();
	await page
		.getByRole("textbox", { name: "Runtime args" })
		.fill("--ctx-size, 8192");
	await page
		.getByRole("button", { name: "Save engine launch settings" })
		.click();
	await expect(page.getByText("Saved", { exact: true })).toBeVisible();
	expect(
		callsFor(
			fixture,
			"PUT",
			"/api/preferences/model.launch.engine.koboldcpp"
		).map((call) => call.body)
	).toEqual([
		{ value: JSON.stringify({ extra_args: ["--ctx-size", "8192"] }) },
	]);

	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-engine-manual-runtime-profile.png"
		),
	});
});

test("speech engines expose per-engine transcription and runtime settings", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	await page.getByRole("button", { name: "Whisper.cpp Fixture" }).click();
	await expect(
		page.getByRole("heading", {
			name: "Speech recognition settings",
			exact: true,
		})
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Core Parakeet settings" })
	).toBeVisible();
	await expect(
		page.getByRole("heading", {
			name: "Gateway speech recognition settings",
		})
	).toBeVisible();
	await expect(
		page.getByText(
			/current in-process runtime does not consume request options/i
		)
	).toBeVisible();
	await page.getByRole("textbox", { name: "Language" }).nth(1).fill("fr");
	await page
		.getByRole("button", { name: "Save transcription settings" })
		.nth(1)
		.click();
	await expect(page.getByText("Saved for this engine").last()).toBeVisible();
	await page.getByRole("textbox", { name: "Language" }).first().fill("fr");
	await page.getByRole("spinbutton", { name: "Beam size" }).first().fill("5");
	await page
		.getByRole("button", { name: "Save transcription settings" })
		.first()
		.click();
	await expect(page.getByText("Saved for this engine").first()).toBeVisible();
	await page.getByRole("textbox", { name: "Language" }).nth(2).fill("es");
	await page
		.getByRole("button", { name: "Save transcription settings" })
		.nth(2)
		.click();
	await expect(page.getByText("Saved for this engine").last()).toBeVisible();
	await page
		.getByRole("heading", {
			name: "Gateway speech recognition settings",
		})
		.scrollIntoViewIfNeeded();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-gateway-stt-settings.png"),
	});
	await page.getByRole("button", { name: "Engine launch settings" }).click();
	await page.getByRole("spinbutton", { name: "Threads" }).fill("6");
	await page
		.getByRole("button", { name: "Save engine launch settings" })
		.click();
	await expect(page.getByText("Saved", { exact: true })).toBeVisible();

	await page.getByRole("button", { name: "Close", exact: true }).click();
	await page.getByRole("button", { name: "Audio.cpp Fixture" }).click();
	await expect(
		page.getByText(/Other typed Whisper options are saved but skipped/i)
	).toBeVisible();
	await page.getByRole("spinbutton", { name: "Threads" }).fill("8");
	await page.getByRole("button", { name: "Save audio.cpp settings" }).click();
	await expect(page.getByText("Saved", { exact: true })).toBeVisible();
	await page.getByRole("textbox", { name: "Language" }).fill("de");
	await page
		.getByRole("button", { name: "Save transcription settings" })
		.click();
	await expect(page.getByText("Saved for this engine")).toBeVisible();

	expect(
		callsFor(
			fixture,
			"PUT",
			"/api/preferences/engine.transcription.parakeet"
		).map((call) => call.body)
	).toEqual([{ value: JSON.stringify({ language: "fr" }) }]);
	expect(
		callsFor(
			fixture,
			"PUT",
			"/api/preferences/engine.transcription.whispercpp"
		).map((call) => call.body)
	).toEqual([{ value: JSON.stringify({ language: "fr", beam_size: 5 }) }]);
	expect(
		callsFor(
			fixture,
			"PUT",
			"/api/preferences/engine.transcription.gateway"
		).map((call) => call.body)
	).toEqual([{ value: JSON.stringify({ language: "es" }) }]);
	expect(
		callsFor(
			fixture,
			"PUT",
			"/api/preferences/model.launch.engine.whispercpp"
		).map((call) => call.body)
	).toEqual([{ value: JSON.stringify({ threads: 6 }) }]);
	expect(
		callsFor(fixture, "PUT", "/api/preferences/engine.audiocpp.runtime").map(
			(call) => call.body
		)
	).toEqual([{ value: JSON.stringify({ threads: 8 }) }]);
	expect(
		callsFor(
			fixture,
			"PUT",
			"/api/preferences/engine.transcription.audiocpp"
		).map((call) => call.body)
	).toEqual([{ value: JSON.stringify({ language: "de" }) }]);

	await page
		.getByText(/Other typed Whisper options are saved but skipped/i)
		.scrollIntoViewIfNeeded();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-speech-engine-settings.png"),
	});
});

test("text-to-speech defaults are reachable from the Ryu Audio engine", async ({
	page,
}) => {
	await page.addInitScript(() => {
		HTMLMediaElement.prototype.play = function () {
			this.dispatchEvent(new Event("ended"));
			return Promise.resolve();
		};
	});
	const fixture = await openStoreSection(page, "engines");
	await page.getByRole("button", { name: "Ryu Audio Fixture" }).click();
	await expect(
		page.getByRole("heading", { name: "Text-to-speech defaults" })
	).toBeVisible();
	const engineSelect = page.getByRole("combobox", { name: "Audio engine" });
	await engineSelect.click();
	await page.getByRole("option", { name: "Pocket Fixture" }).click();
	await expect(page.getByRole("combobox", { name: "Voice" })).toBeVisible();
	await page.getByRole("spinbutton", { name: "Speaking speed" }).fill("1.25");
	await page.getByRole("combobox", { name: "Language" }).click();
	await page.getByRole("option", { name: "en" }).click();
	await page
		.getByRole("textbox", { name: "Reference audio path" })
		.fill("/voice/references/pocket-sample.wav");
	await page.getByRole("button", { name: "Test voice" }).click();
	await expect
		.poll(() => callsFor(fixture, "POST", "/api/voice/speak").length)
		.toBe(1);
	expect(
		callsFor(fixture, "POST", "/api/voice/speak").map((call) => call.body)
	).toEqual([
		{
			engine: "pocket",
			language: "en",
			reference_audio: "/voice/references/pocket-sample.wav",
			speed: 1.25,
			text: "Hi, this is Ryu speaking with the selected voice engine.",
			voice: "alba",
		},
	]);

	await page
		.getByRole("heading", { name: "Text-to-speech defaults" })
		.scrollIntoViewIfNeeded();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-tts-engine-settings.png"),
	});
	const ttsEngineListRequests = callsFor(
		fixture,
		"GET",
		"/api/voice/tts-engines"
	).length;
	expect(ttsEngineListRequests).toBeGreaterThan(0);
	expect(ttsEngineListRequests).toBeLessThanOrEqual(2);
	const speechEngineOptions = await page.evaluate(() =>
		localStorage.getItem("ryu.tts.engine-options")
	);
	expect(JSON.parse(speechEngineOptions ?? "{}")).toEqual({
		pocket: {
			language: "en",
			referenceAudio: "/voice/references/pocket-sample.wav",
			speed: 1.25,
			voice: "alba",
		},
	});
});

test("Speech Processing defaults are shared from the llama.cpp engine detail", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	await page.getByRole("button", { name: "llama.cpp" }).click();
	await expect(
		page.getByRole("heading", { name: "Speech Processing defaults" })
	).toBeVisible();
	await page.getByRole("combobox", { name: "Style" }).click();
	await page.getByRole("option", { name: "Formal", exact: true }).click();
	await page
		.getByRole("button", { name: "Save Speech Processing settings" })
		.click();
	await expect(page.getByText("Saved", { exact: true })).toBeVisible();
	expect(
		callsFor(fixture, "PUT", "/api/preferences/speech-processing").map(
			(call) => call.body
		)
	).toEqual([
		{
			value: JSON.stringify({
				context: "general",
				engine: "s1-mini",
				structure: "prose",
				styling: "formal",
			}),
		},
	]);

	await page
		.getByRole("heading", { name: "Speech Processing defaults" })
		.scrollIntoViewIfNeeded();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-speech-processing-settings.png"
		),
	});
});

test("Library engines configure chat and embeddings in place and share Store defaults", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page, "http://127.0.0.1:5192");
	await page.goto("/library-engine-settings.html");
	await expect(page.getByRole("tab", { selected: true })).toContainText(
		"Engines"
	);
	await page.getByText("llama.cpp", { exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Advanced configuration" })
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Embedding engine" })
	).toBeVisible();
	await page
		.getByRole("button", { name: "Sampling defaults", exact: true })
		.click();
	await page.getByRole("spinbutton", { name: "Temperature" }).fill("0.55");
	await page.getByRole("button", { name: "Save sampling defaults" }).click();
	await expect(page.getByText("Saved for this engine")).toBeVisible();
	expect(
		callsFor(fixture, "PUT", "/api/preferences/inference.engine.llamacpp").map(
			(call) => call.body
		)
	).toEqual([{ value: JSON.stringify({ temperature: 0.55 }) }]);
	await page
		.getByRole("heading", { name: "Advanced configuration" })
		.scrollIntoViewIfNeeded();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "library-engine-advanced-settings.png"),
	});
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await expect(page.getByRole("tab", { selected: true })).toContainText(
		"Engines"
	);
	await expect(page.getByPlaceholder("Search your library…")).toBeVisible();
	await expect(page).toHaveURL(/library-engine-settings\.html$/);
	await prepareEvidenceCapture(page);
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "library-engine-settings-cards.png"),
	});
	await page.goto("/library-engine-settings.html?surface=store");
	await page.getByRole("button", { name: "llama.cpp" }).click();
	await page
		.getByRole("button", { name: "Sampling defaults", exact: true })
		.click();
	await expect(
		page.getByRole("spinbutton", { name: "Temperature" })
	).toHaveValue("0.55");
});

test("Library engines expose speech runtime and text-to-speech settings without leaving Library", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page, "http://127.0.0.1:5192");
	await page.goto("/library-engine-settings.html");
	await page.getByText("Audio.cpp Fixture", { exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Audio runtime settings" })
	).toBeVisible();
	await page.getByRole("spinbutton", { name: "Threads" }).fill("7");
	await page.getByRole("button", { name: "Save audio.cpp settings" }).click();
	await expect(page.getByText("Saved", { exact: true })).toBeVisible();
	expect(
		callsFor(fixture, "PUT", "/api/preferences/engine.audiocpp.runtime").map(
			(call) => call.body
		)
	).toEqual([{ value: JSON.stringify({ threads: 7 }) }]);
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await page.getByText("Ryu Audio Fixture", { exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Text-to-speech defaults" })
	).toBeVisible();
	await expect(
		page.getByRole("combobox", { name: "Audio engine" })
	).toBeVisible();
	await expect(page).toHaveURL(/library-engine-settings\.html$/);
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "library-engine-tts-settings.png"),
	});
});

test("Library engines open every chat engine and fit a compact window", async ({
	page,
}) => {
	const fixture = await installLocalFixture(page, "http://127.0.0.1:5192");
	await page.goto("/library-engine-settings.html");
	const chatEngines = engineCatalogItems(fixture).filter(
		(engine) => engine.category === "provider"
	);
	expect(chatEngines).toHaveLength(15);
	for (const engine of chatEngines) {
		await page.getByText(engine.display_name, { exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "Advanced configuration" })
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Sampling defaults", exact: true })
		).toBeVisible();
		await expect(
			page
				.getByRole("button", { name: "Engine launch settings", exact: true })
				.first()
		).toBeVisible();
		await page.getByRole("button", { name: "Close", exact: true }).click();
	}
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByText("llama.cpp", { exact: true }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await expect
		.poll(() =>
			page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth
			)
		)
		.toBe(true);
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "library-engine-settings-compact.png"),
	});
});

test("Engine permission denials preserve install and active state before exact retry readback", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	const denied: RequestRecord[] = [];
	const denyNext = async (path: string) => {
		await page.route(`**${path}`, async (route) => {
			if (route.request().method() !== "POST") {
				await route.fallback();
				return;
			}
			await page.unroute(`**${path}`);
			expect(route.request().headers().authorization).toBe(
				"Bearer fixture-node-token"
			);
			denied.push({
				method: "POST",
				path,
				search: "",
				body: route.request().postDataJSON(),
			});
			await route.fulfill({
				status: 403,
				contentType: "application/json",
				body: JSON.stringify({ error: "Engine action denied by policy" }),
			});
		});
	};
	const card = page
		.getByRole("button", { name: "KoboldCPP Fixture" })
		.locator("xpath=..");
	await denyNext(`/api/setup/${IDS.engineNew}/install`);
	await card.getByRole("button", { name: "Get", exact: true }).click();
	await expect(card.getByRole("alert")).toContainText("denied by policy");
	expect(fixture.engineInstalled.has(IDS.engineNew)).toBe(false);
	await card.getByRole("button", { name: "Get", exact: true }).click();
	await expect(card.getByRole("button", { name: "Installed" })).toBeVisible();
	await page.getByRole("button", { name: "KoboldCPP Fixture" }).click();
	const activeSwitch = page.getByRole("switch", {
		name: "Set KoboldCPP Fixture as active engine",
	});
	await denyNext("/api/engine/active");
	await activeSwitch.click();
	await expect(
		page
			.getByRole("dialog")
			.getByText("/api/engine/active failed: 403", { exact: true })
	).toBeVisible();
	expect(fixture.engineActive).toBe(IDS.engineActive);
	await expect(activeSwitch).not.toBeChecked();
	await activeSwitch.click();
	await expect(activeSwitch).toBeChecked();
	expect(denied).toEqual([
		{
			method: "POST",
			path: `/api/setup/${IDS.engineNew}/install`,
			search: "",
			body: null,
		},
		{
			method: "POST",
			path: "/api/engine/active",
			search: "",
			body: { name: IDS.engineNew },
		},
	]);
	expect(
		callsFor(fixture, "POST", `/api/setup/${IDS.engineNew}/install`).map(
			(call) => call.body
		)
	).toEqual([null]);
	expect(
		callsFor(fixture, "POST", "/api/engine/active").map((call) => call.body)
	).toEqual([{ name: IDS.engineNew }]);
	await page.reload();
	await page.getByRole("button", { name: "KoboldCPP Fixture" }).click();
	await expect(
		page.getByRole("switch", { name: "Set KoboldCPP Fixture as active engine" })
	).toBeChecked();
	await prepareEvidenceCapture(page);
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-engine-policy-retry-readback.png"
		),
	});
});

test("Engine pending install withholds card context mutations until exact readback", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	const gate = deferred();
	fixture.engineActionGates[`${IDS.engineNew}:install`] = gate;
	const engine = page.getByRole("button", { name: "KoboldCPP Fixture" });
	const card = engine.locator("xpath=..");
	await card.getByRole("button", { name: "Get", exact: true }).click();
	await expect
		.poll(
			() =>
				callsFor(fixture, "POST", `/api/setup/${IDS.engineNew}/install`).length
		)
		.toBe(1);
	await engine.click({ button: "right" });
	await expect(
		page.getByRole("menuitem", { name: "Get", exact: true })
	).toHaveCount(0);
	expect(fixture.engineInstalled.has(IDS.engineNew)).toBe(false);
	await page.keyboard.press("Escape");
	gate.release();
	await expect(card.getByRole("button", { name: "Installed" })).toBeVisible();
	expect(
		callsFor(fixture, "POST", `/api/setup/${IDS.engineNew}/install`).map(
			(call) => call.body
		)
	).toEqual([null]);
	await page.reload();
	await expect(
		page
			.getByRole("button", { name: "KoboldCPP Fixture" })
			.locator("xpath=..")
			.getByRole("button", { name: "Installed" })
	).toBeVisible();
	await prepareEvidenceCapture(page);
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-engine-pending-install-readback.png"
		),
	});
});

test.afterEach(async ({ page }, testInfo) => {
	const diagnostic = engineDiagnostics.get(page);
	if (!diagnostic) {
		return;
	}
	const name = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
	const completed = testInfo.status === testInfo.expectedStatus;
	let dialogGeometry: { opacity: string; width: number; height: number }[] = [];
	if (completed) {
		await page.evaluate(() => document.fonts.ready);
		const dialogs = page.getByRole("dialog");
		for (const dialog of await dialogs.all()) {
			await expect(dialog).toHaveCSS("opacity", "1");
		}
		dialogGeometry = await dialogs.evaluateAll((elements) =>
			elements.map((element) => {
				const bounds = element.getBoundingClientRect();
				return {
					opacity: getComputedStyle(element).opacity,
					width: bounds.width,
					height: bounds.height,
				};
			})
		);
		await page.screenshot({
			path: resolve(EVIDENCE_DIR, `${name}-completed.png`),
			fullPage: true,
			animations: "disabled",
		});
	}
	writeFileSync(
		resolve(EVIDENCE_DIR, `${name}-contracts.json`),
		JSON.stringify(
			{
				calls: diagnostic.fixture.calls,
				unknown: diagnostic.unknown,
				pageErrors: diagnostic.pageErrors,
				completed,
				dialogGeometry,
			},
			null,
			2
		)
	);
	if (diagnostic.unknown.length || diagnostic.pageErrors.length) {
		await page.screenshot({
			path: resolve(EVIDENCE_DIR, `${name}-contract-failure.png`),
			fullPage: true,
		});
	}
	expect(
		diagnostic.unknown,
		"Engines must not depend on unrecognized successful API fixtures"
	).toEqual([]);
	expect(
		diagnostic.pageErrors,
		"Engines production callers must not throw uncaught errors"
	).toEqual([]);
});

// Retain the rendered failure state for the focused Engine diagnostics.
test.afterEach(async ({ page }, testInfo) => {
	if (
		testInfo.status === testInfo.expectedStatus ||
		!/Engines list|llama\.cpp acceleration/.test(testInfo.title)
	) {
		return;
	}
	await testInfo.attach("engine-render-state", {
		body: await page.locator("body").innerText(),
		contentType: "text/plain",
	});
	await page.screenshot({
		path: testInfo.outputPath("engine-render-state.png"),
		fullPage: true,
	});
	console.info(
		"Engine rendered state:",
		await page.locator("body").innerText()
	);
});
