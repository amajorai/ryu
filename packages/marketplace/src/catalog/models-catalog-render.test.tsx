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
import ModelsCatalogSection, {
	ModelsFilterPanel,
} from "./models-catalog-section.tsx";
import type { ModelCard, ModelCatalogState, ModelDetail } from "./types.ts";

const MOCK_INSTALL: CatalogInstall = {
	InstallButton: ({ children, disabled }) => (
		<button data-testid="install-button" disabled={disabled} type="button">
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
		usePersistedToggle: (_k: string, d: boolean) => [d, () => undefined],
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
		ActiveModelControl: ({ chatCapable = false, format, repoId }) => (
			<button
				data-format={format}
				data-model-action={chatCapable ? "chat" : "runtime"}
				data-model-id={repoId}
				type="button"
			>
				{chatCapable ? "Chat with this model" : "Use this model"}
			</button>
		),
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

function renderFilterPanel(showInstalledOnly: boolean): string {
	return renderToStaticMarkup(
		<ModelsFilterPanel
			activeSource="huggingface"
			activeTokens={new Set()}
			category="all"
			chips={[]}
			format="gguf"
			friendly={false}
			installedOnly={false}
			selectingSource={false}
			selectSource={() => undefined}
			setCategory={() => undefined}
			setFormat={() => undefined}
			setFriendly={() => undefined}
			setInstalledOnly={() => undefined}
			setShowTags={() => undefined}
			setSort={() => undefined}
			showInstalledOnly={showInstalledOnly}
			showTags={false}
			sort="trending"
			sources={[{ displayName: "Hugging Face", id: "huggingface" }]}
			toggleToken={() => undefined}
		/>
	);
}

describe("ModelsCatalogSection — list states", () => {
	test("web filter panel keeps model facets but omits desktop Added control", () => {
		const html = renderFilterPanel(false);
		expect(html).toContain("All categories");
		expect(html).toContain("Runs anywhere (GGUF)");
		expect(html).toContain("Trending");
		expect(html).toContain("Tags");
		expect(html).not.toContain("Added only");
	});

	test("desktop filter panel retains the Added control", () => {
		expect(renderFilterPanel(true)).toContain("Added only");
	});

	test("loading with no models shows no empty/error copy", () => {
		const html = render(makeModelsState({ loading: true, models: [] }));
		expect(html).not.toContain("No models found");
		expect(html).not.toContain("Couldn't load models");
	});

	test("error surfaces the load-failure message", () => {
		const html = render(
			makeModelsState({ error: "boom", models: [], loading: false })
		);
		expect(html).toContain("Couldn&#x27;t load models");
		expect(html).toContain("boom");
		expect(html).toContain("Try again");
	});

	test("empty (loaded, no models) shows the browse empty state", () => {
		const html = render(makeModelsState({ models: [], loading: false }));
		expect(html).toContain("No models found");
		expect(html).toContain("Try a different search.");
	});

	test("added-only empty state reads differently", () => {
		const html = render(
			makeModelsState({ models: [], installedOnly: true, loading: false })
		);
		expect(html).toContain("No models added yet");
	});
});

describe("ModelsCatalogSection — populated list", () => {
	test("renders a card's author + friendly download/like counts", () => {
		const html = render(makeModelsState({ models: [makeModel()] }));
		expect(html).toContain("google");
		// formatCount: 1,234,567 -> 1.2m downloads, 4200 -> 4,200 likes.
		expect(html).toContain("1.2m");
		expect(html).toContain("4,200");
		// formatContext(32768) -> "32,768 context".
		expect(html).toContain("32,768 context");
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

	test("puts the installed model's chat action next to the device-fit summary", () => {
		const markup = render(
			makeModelsState({
				detail: makeDetail({
					card: makeModel({ id: "google/gemma-4b", installed: true }),
				}),
				selectedId: "google/gemma-4b",
			})
		);

		expect(markup).toContain("Run in chat");
		expect(markup).toContain('data-model-action="chat"');
		expect(markup.indexOf("Run in chat")).toBeLessThan(
			markup.indexOf("Download options")
		);
	});

	test("keeps non-chat models on their runtime action and hides fine-tuning", () => {
		const markup = render(
			makeModelsState({
				detail: makeDetail({
					card: makeModel({
						id: "black-forest-labs/flux",
						installed: true,
						pipelineTag: "text-to-image",
					}),
				}),
				selectedId: "black-forest-labs/flux",
			})
		);

		expect(markup).toContain("Use this model");
		expect(markup).toContain('data-model-action="runtime"');
		expect(markup).not.toContain("Run in chat");
		expect(markup).not.toContain("Fine-tune this model");
	});
});

describe("ModelsCatalogSection — quant download picker", () => {
	const THREE_QUANTS: ModelDetail["files"] = [
		{
			filename: "gemma-4b-Q8_0.gguf",
			fit: "partial",
			fitLabel: "May be tight",
			installed: false,
			quant: "Q8_0",
			sizeBytes: 5_000_000_000,
			sizeHuman: "5.0 GB",
		},
		{
			filename: "gemma-4b-Q4_K_M.gguf",
			fit: "great",
			fitLabel: "Fits your device",
			installed: false,
			quant: "Q4_K_M",
			sizeBytes: 2_500_000_000,
			sizeHuman: "2.5 GB",
		},
		{
			filename: "gemma-4b-F16.gguf",
			fit: "too_big",
			fitLabel: "Too large for your device",
			installed: false,
			quant: "F16",
			sizeBytes: 10_000_000_000,
			sizeHuman: "10 GB",
		},
	];

	function renderDetail(
		files: ModelDetail["files"],
		over: Partial<ModelDetail> = {}
	): string {
		return render(
			makeModelsState({
				models: [makeModel()],
				selectedId: "google/gemma-4b",
				detail: makeDetail({ files, ...over }),
			})
		);
	}

	test("collapses the quants into one dropdown preselected to the best fit", () => {
		const html = renderDetail(THREE_QUANTS);
		expect(html).toContain("Download options");
		// The best-fitting quant (great) is preselected — the hidden input carries
		// its filename; the trigger shows its friendly label.
		expect(html).toContain('value="gemma-4b-Q4_K_M.gguf"');
		expect(html).toContain("Balanced (recommended)");
		// No per-quant Add rows — one select + one Add button instead.
		expect(html.match(/Download options/g)).toHaveLength(1);
		expect(html.match(/data-testid="install-button"/g)).toHaveLength(1);
	});

	test("badges the recommendation for this device's OS", () => {
		const html = renderDetail(THREE_QUANTS, {
			device: {
				gpuName: "M3 Max",
				os: "macos",
				ramHuman: "36 GB",
				unifiedMemory: true,
				vramBytes: null,
				vramHuman: "",
			},
		});
		expect(html).toContain("Recommended for your Mac");
	});

	test("the recommendation badge follows the selected quant", () => {
		// All quants fit equally well: the picker still defaults to the smallest.
		const html = renderDetail([
			{
				filename: "gemma-4b-Q8_0.gguf",
				fit: "ok",
				fitLabel: "Fits",
				installed: false,
				quant: "Q8_0",
				sizeBytes: 5_000_000_000,
				sizeHuman: "5.0 GB",
			},
			{
				filename: "gemma-4b-Q4_K_M.gguf",
				fit: "ok",
				fitLabel: "Fits",
				installed: false,
				quant: "Q4_K_M",
				sizeBytes: 2_500_000_000,
				sizeHuman: "2.5 GB",
			},
		]);
		expect(html).toContain('value="gemma-4b-Q4_K_M.gguf"');
		expect(html).toContain("Recommended for your PC");
	});

	test("never preselects a blocked quant while one that fits exists", () => {
		const html = renderDetail([
			{
				filename: "gemma-4b-F16.gguf",
				fit: "no_space",
				fitLabel: "Not enough free disk space to download it",
				installed: false,
				quant: "F16",
				sizeBytes: 1_000_000_000,
				sizeHuman: "1 GB",
			},
			{
				filename: "gemma-4b-Q4_K_M.gguf",
				fit: "unknown",
				fitLabel: "Can't check your device",
				installed: false,
				quant: "Q4_K_M",
				sizeBytes: 2_500_000_000,
				sizeHuman: "2.5 GB",
			},
		]);
		expect(html).toContain('value="gemma-4b-Q4_K_M.gguf"');
		expect(html).not.toMatch(/data-testid="install-button" disabled/);
	});

	test("disables Add with the device numbers when every quant is too big", () => {
		const html = renderDetail(
			[
				{
					filename: "gemma-4b-F16.gguf",
					fit: "too_big",
					fitLabel: "Too large for your device's memory",
					installed: false,
					quant: "F16",
					sizeBytes: 10_000_000_000,
					sizeHuman: "10 GB",
				},
			],
			{
				device: {
					gpuName: null,
					os: "linux",
					ramHuman: "8 GB",
					unifiedMemory: false,
					vramBytes: null,
					vramHuman: "",
				},
			}
		);
		expect(html).toMatch(/data-testid="install-button" disabled/);
		expect(html).toContain("This device has 8 GB of RAM.");
		expect(html).not.toContain("Recommended for your PC");
	});

	test("explains a no-space verdict with the free disk", () => {
		const html = renderDetail(
			[
				{
					filename: "gemma-4b-Q4_K_M.gguf",
					fit: "no_space",
					fitLabel: "Not enough free disk space to download it",
					installed: false,
					quant: "Q4_K_M",
					sizeBytes: 2_500_000_000,
					sizeHuman: "2.5 GB",
				},
			],
			{
				device: {
					diskFreeHuman: "1.2 GB",
					gpuName: null,
					os: "linux",
					ramHuman: "64 GB",
					unifiedMemory: false,
					vramBytes: null,
					vramHuman: "",
				},
			}
		);
		expect(html).toMatch(/data-testid="install-button" disabled/);
		expect(html).toContain("Only 1.2 GB is free on the models drive.");
		expect(html).toContain("1.2 GB free disk");
	});

	test("keeps a slow quant installable but warns it may be slow", () => {
		const html = renderDetail([
			{
				filename: "gemma-4b-Q4_K_M.gguf",
				fit: "cpu",
				fitLabel: "Runs on your CPU only — may be slow",
				installed: false,
				quant: "Q4_K_M",
				sizeBytes: 2_500_000_000,
				sizeHuman: "2.5 GB",
			},
		]);
		expect(html).not.toMatch(/data-testid="install-button" disabled/);
		expect(html).toContain("May be slow on this device");
	});

	const snapshotDevice = {
		gpuName: "RTX 4090",
		os: "linux",
		ramHuman: "64 GB",
		unifiedMemory: false,
		vramBytes: 24_000_000_000,
		vramHuman: "24 GB",
	};

	test("disables a snapshot install whose repo verdict is blocked", () => {
		// A current Core reports the node's free disk (even as null).
		const html = renderDetail([], {
			card: makeModel({ format: "safetensors" }),
			device: { ...snapshotDevice, diskFreeBytes: 500_000_000_000 },
			format: "safetensors",
			repoFit: "too_big",
			repoFitLabel: "Too large for your device's memory",
		});
		expect(html).toMatch(/data-testid="install-button" disabled/);
		expect(html).toContain(
			"This device has 64 GB of RAM and 24 GB of GPU memory."
		);
	});

	test("an older Core's soft too_big keeps the snapshot installable with a warning", () => {
		// An older Core sends no disk numbers and still installs a too_big repo.
		const html = renderDetail([], {
			card: makeModel({ format: "safetensors" }),
			device: snapshotDevice,
			format: "safetensors",
			repoFit: "too_big",
			repoFitLabel: "May not fit",
		});
		expect(html).not.toMatch(/data-testid="install-button" disabled/);
		expect(html).toContain("May be slow on this device");
		expect(html).not.toContain("You can't add it on this device");
	});

	test("does not offer an importance matrix as a model quant", () => {
		const html = renderDetail([
			{
				filename: "imatrix_unsloth.gguf",
				fit: "great",
				fitLabel: "Runs great — fully on your GPU",
				installed: false,
				quant: null,
				sizeBytes: 13_000_000,
				sizeHuman: "13 MB",
			},
			{
				filename: "model-Q4_K_M.gguf",
				fit: "ok",
				fitLabel: "Fits",
				installed: false,
				quant: "Q4_K_M",
				sizeBytes: 2_500_000_000,
				sizeHuman: "2.5 GB",
			},
		]);
		expect(html).toContain('value="model-Q4_K_M.gguf"');
		expect(html).not.toContain("imatrix_unsloth.gguf");
	});
});
