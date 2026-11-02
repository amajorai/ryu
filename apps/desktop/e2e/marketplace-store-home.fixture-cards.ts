// Engine, skill and MCP catalog cards the Store home fixture serves.

import {
	type EngineCatalogFixture,
	type Fixture,
	IDS,
} from "./marketplace-store-home.fixture.ts";

export function engineCatalogItems(fixture: Fixture) {
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

export function skillFixtureCards(fixture: Fixture) {
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

export function mcpFixtureCards(fixture: Fixture, source: string) {
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
