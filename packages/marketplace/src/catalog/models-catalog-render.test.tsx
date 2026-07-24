// Render-through-the-host tests for the shared Models catalog section — the
// package's single largest untested surface. The section is exercised by
// injecting a fake CatalogHost and rendering to static markup (no DOM, no
// network), the same idiom as apps-catalog-render.test.tsx. A populated `models`
// list cascades through ModelList + the shared catalog badges; a populated
// `detail` renders ModelDetailPanel.
//
// Scope note: the detail panel renders inline via ResizableMasterDetail (not a
// portaled Dialog), so both the list and the detail are emitted by
// renderToStaticMarkup here.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	type CatalogHost,
	CatalogHostProvider,
	type CatalogInstall,
} from "./host.tsx";
import ModelsCatalogSection from "./models-catalog-section.tsx";
import type {
	ModelCard,
	ModelCatalogState,
	ModelDetail,
} from "./types.ts";

const MOCK_INSTALL: CatalogInstall = {
	InstallButton: ({ children }) => (
		<button data-testid="install-button" type="button">
			{children}
		</button>
	),
};

function makeModel(over: Partial<ModelCard> = {}): ModelCard {
	return {
		architecture: null,
		author: "google",
		compatible: true,
		contextLength: 32_768,
		createdAt: "2026-01-01T00:00:00Z",
		downloads: 1_234_567,
		format: "gguf",
		gated: false,
		id: "google/gemma-4b",
		installed: false,
		lastModified: "2026-06-01T00:00:00Z",
		likes: 4200,
		name: "Gemma-4B-Instruct",
		needsEngine: null,
		params: 4_000_000_000,
		pipelineTag: "text-generation",
		tags: [],
		...over,
	};
}

function makeModelsState(
	over: Partial<ModelCatalogState> = {}
): ModelCatalogState {
	return {
		activeSource: "huggingface",
		browseOrg: () => undefined,
		category: "all",
		detail: null,
		detailError: null,
		detailLoading: false,
		error: null,
		fetchNextPage: () => undefined,
		format: "gguf",
		hasNextPage: false,
		install: () => Promise.resolve(),
		installedOnly: false,
		installing: null,
		installingSnapshot: false,
		installSnapshot: () => Promise.resolve(),
		loading: false,
		loadingMore: false,
		models: [],
		org: "",
		query: "",
		select: () => undefined,
		selectedId: null,
		selectingSource: false,
		selectSource: () => undefined,
		setCategory: () => undefined,
		setFormat: () => undefined,
		setInstalledOnly: () => undefined,
		setOrg: () => undefined,
		setQuery: () => undefined,
		setSort: () => undefined,
		sort: "trending",
		sources: [{ displayName: "Hugging Face", id: "huggingface" }],
		uninstall: () => Promise.resolve(),
		uninstalling: null,
		...over,
	};
}

function makeDetail(over: Partial<ModelDetail> = {}): ModelDetail {
	return {
		card: makeModel({ id: "google/gemma-4b", name: "Gemma-4B-Instruct" }),
		device: {
			gpuName: "RTX 4090",
			os: "linux",
			ramHuman: "64 GB",
			unifiedMemory: false,
			vramBytes: 24_000_000_000,
			vramHuman: "24 GB",
		},
		files: [
			{
				filename: "gemma-4b-Q4_K_M.gguf",
				fit: "great",
				fitLabel: "Great fit",
				installed: false,
				quant: "Q4_K_M",
				sizeBytes: 2_500_000_000,
				sizeHuman: "2.5 GB",
			},
		],
		format: "gguf",
		readme: null,
		repoFitLabel: "Great fit",
		repoSizeBytes: 2_500_000_000,
		stats: null,
		statsApiKeyPresent: false,
		vision: false,
		...over,
	};
}

function makeHost(
	state: ModelCatalogState,
	install: CatalogInstall | null = MOCK_INSTALL
): CatalogHost {
	return {
		install,
		Markdown: ({ content }) => <div>{content}</div>,
		openExternal: () => undefined,
		renderAffordance: (target) => <span>Open {target.name} in Ryu</span>,
		useAppsCatalog: () => {
			throw new Error("unused");
		},
		useSkillsCatalog: () => {
			throw new Error("unused");
		},
		useModelCatalog: () => state,
		useActiveNode: () => ({ url: "", token: null }),
		usePersistedToggle: (_k: string, d: boolean) =>
			[d, () => undefined] as [boolean, (v: boolean) => void],
		installSidecar: () => Promise.resolve(),
		estimateLlmfit: () =>
			Promise.resolve({
				fit_level: null,
				installed: false,
				matched: false,
				min_vram_gb: null,
				path: null,
				tps: null,
			}),
		useInstalledModels: () => [],
		ActiveModelControl: () => null,
		fitStyle: () => ({ className: "", dot: "" }),
	};
}

function render(
	state: ModelCatalogState,
	install: CatalogInstall | null = MOCK_INSTALL
): string {
	return renderToStaticMarkup(
		<CatalogHostProvider host={makeHost(state, install)}>
			<ModelsCatalogSection />
		</CatalogHostProvider>
	);
}

describe("ModelsCatalogSection — list states", () => {
	test("loading with no models shows no empty/error copy", () => {
		const html = render(makeModelsState({ loading: true, models: [] }));
		expect(html).not.toContain("No models found");
		expect(html).not.toContain("Couldn't load models");
	});

	test("error surfaces the load-failure message", () => {
		const html = render(
			makeModelsState({ error: "boom", models: [], loading: false })
		);
		expect(html).toContain("load models: boom");
	});

	test("empty (loaded, no models) shows the browse empty state", () => {
		const html = render(makeModelsState({ models: [], loading: false }));
		expect(html).toContain("No models found");
		expect(html).toContain("Try a different search.");
	});

	test("installed-only empty state reads differently", () => {
		const html = render(
			makeModelsState({ models: [], installedOnly: true, loading: false })
		);
		expect(html).toContain("No installed models yet");
	});
});

describe("ModelsCatalogSection — populated list", () => {
	test("renders a card's author + friendly download/like counts", () => {
		const html = render(makeModelsState({ models: [makeModel()] }));
		expect(html).toContain("google");
		// formatCount: 1,234,567 -> 1.2M downloads, 4200 -> 4.2k likes.
		expect(html).toContain("1.2M");
		expect(html).toContain("4.2k");
		// formatContext(32768) -> "32K context".
		expect(html).toContain("32K context");
	});

	test("an incompatible model surfaces the needs-engine badge", () => {
		const html = render(
			makeModelsState({
				models: [
					makeModel({
						compatible: false,
						needsEngine: "vLLM",
						format: "safetensors",
					}),
				],
			})
		);
		expect(html).toContain("Needs vLLM");
	});

	test("an incompatible MLX model reads 'macOS only'", () => {
		const html = render(
			makeModelsState({
				models: [makeModel({ compatible: false, format: "mlx" })],
			})
		);
		expect(html).toContain("macOS only");
	});

	test("the org guard hides an out-of-org card even if the hook leaks it", () => {
		// filterModelsByTokens runs inside the section: an active org drops a card
		// whose author differs, regardless of what the injected hook returned.
		const html = render(
			makeModelsState({
				org: "google",
				models: [
					makeModel({ id: "google/keep", name: "Gemma-4B", author: "google" }),
					makeModel({ id: "meta/leak", name: "Llama-8B", author: "meta" }),
				],
			})
		);
		expect(html).toContain("Gemma");
		expect(html).not.toContain("Llama");
	});
});

describe("ModelsCatalogSection — detail panel", () => {
	test("a populated detail renders the model's file + quant label", () => {
		const html = render(
			makeModelsState({
				models: [makeModel()],
				selectedId: "google/gemma-4b",
				detail: makeDetail(),
			})
		);
		// friendlyQuant(Q4_K_M) -> "Balanced (recommended)" quant tier label.
		expect(html).toContain("Balanced (recommended)");
	});

	test("detail error is surfaced in the panel", () => {
		const html = render(
			makeModelsState({
				selectedId: "google/gemma-4b",
				detailError: "detail exploded",
			})
		);
		expect(html).toContain("detail exploded");
	});
});
