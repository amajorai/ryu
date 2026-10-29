import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { CatalogHost, CatalogInstall } from "./host.tsx";
import type { ModelCard, ModelCatalogState, ModelDetail } from "./types.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CatalogHostProvider } = await import("./host.tsx");
const { default: ModelsCatalogSection, fineTuneHrefForModel } = await import(
	"./models-catalog-section.tsx"
);

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

test("rendered selected model Fine-tune action navigates to its encoded Companion URL", async () => {
	const modelId = "org/selected model+revision?variant=4bit";
	const card = makeModel({ id: modelId, name: "Selected chat model" });
	const state = makeModelsState({
		models: [card],
		selectedId: modelId,
		detail: makeDetail({ card }),
	});
	const navigated: string[] = [];
	const host = {
		...makeHost(state),
		navigate: (href: string) => navigated.push(href),
	};
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(async () => {
			root.render(
				<CatalogHostProvider host={host}>
					<ModelsCatalogSection />
				</CatalogHostProvider>
			);
		});
		const action = [...container.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "Fine-tune"
		);
		expect(action).toBeDefined();
		expect(navigated).toEqual([]);
		await act(async () => {
			action?.click();
		});
		expect(navigated).toEqual([fineTuneHrefForModel(modelId)]);
		expect(navigated[0]).toBe(
			"/plugin/@ryu/finetune?base_model_id=org%2Fselected%20model%2Brevision%3Fvariant%3D4bit"
		);
	} finally {
		await act(async () => {
			root.unmount();
		});
		container.remove();
	}
});
