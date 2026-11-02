// Core fixture state, records and JSON helpers for the marketplace Store
// home proofs (marketplace-store-home*.spec.ts).

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Page, Route } from "@playwright/test";
import type {
	AppPresentation,
	CatalogEntry,
	PluginContributions,
} from "../src/lib/api/plugins.ts";
import {
	type StoreProofJson,
	storeProofJsonSchema,
} from "./marketplace-store-home-proof.contracts.ts";
import { proofEvidencePath } from "./proof-evidence-path.ts";

export const STORY_URL = "/marketplace-store-home.html";
export const API_ORIGIN =
	process.env.RYU_STORE_TEST_API_ORIGIN ?? "http://127.0.0.1:5191";
export const EVIDENCE_DIR = resolve(
	process.env.RYU_STORE_TEST_PROOF_DIR ??
		proofEvidencePath("test-coverage-sweep-20260924/evidence")
);
mkdirSync(EVIDENCE_DIR, { recursive: true });

export interface EngineFixtureDiagnostics {
	fixture: Fixture;
	pageErrors: string[];
	unknown: RequestRecord[];
}
export const engineDiagnostics = new WeakMap<Page, EngineFixtureDiagnostics>();

// getPluginContributions consumes this complete array envelope directly.
export const EMPTY_ENGINE_CONTRIBUTIONS = {
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

export interface RequestRecord {
	body: StoreProofJson;
	method: string;
	path: string;
	search: string;
}

export interface RecommendationFixture {
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

export interface SourceFixture {
	base_url: string | null;
	builtin: boolean;
	display_name: string;
	id: string;
}

export interface ReviewFixture {
	body: string | null;
	createdAt: string;
	id: string;
	mine: boolean;
	rating: number;
	title: string | null;
	userName: string | null;
	verifiedPurchase: boolean;
}

export interface EngineCatalogFixture {
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

export interface Fixture {
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

export const IDS = {
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

export function modelCard(
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

export function createFixture(): Fixture {
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

export async function json<FixturePayload>(
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

export async function requestBody(route: Route): Promise<StoreProofJson> {
	try {
		return storeProofJsonSchema.parse(route.request().postDataJSON());
	} catch {
		return undefined;
	}
}

export function appCatalogEntry(
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

export function appLifecycle(fixture: Fixture, id: string) {
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
