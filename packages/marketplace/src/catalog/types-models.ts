// packages/marketplace/src/catalog/types-models.ts
//
// Models realm cards, detail, filters, and the Models section's hook state.
// Split out of `types.ts`, which re-exports everything here so existing import
// paths keep working.

// ---------------------------------------------------------------------------
// Models realm
//
// Structural subsets of the desktop model-catalog types (apps/desktop/src/lib/
// api/models.ts + useModelCatalog). They declare ONLY the fields the Models
// section reads, so the desktop concrete hook result (a superset) stays
// structurally assignable when injected through the host, and web fabricates
// exactly these fields from its federated catalog.
// ---------------------------------------------------------------------------

/** How the catalog list is ordered. */
export type ModelSort = "trending" | "downloads" | "likes" | "recent";

/** Model weight format (which engine family can serve it). */
export type ModelFormat = "gguf" | "safetensors" | "mlx";

/**
 * Model task filters shared by the catalog UI and the Desktop-to-Core adapter.
 * Each non-`all` option is one Hugging Face pipeline tag; keeping the tag next
 * to its label prevents the UI and request mapping from drifting apart.
 */
export const MODEL_CATEGORY_OPTIONS = [
	{ value: "all", label: "All categories", pipelineTag: "" },
	{ value: "chat", label: "Chat / text", pipelineTag: "text-generation" },
	{ value: "vision", label: "Vision", pipelineTag: "image-text-to-text" },
	{
		value: "image-captioning",
		label: "Image to text",
		pipelineTag: "image-to-text",
	},
	{
		value: "image-generation",
		label: "Image generation",
		pipelineTag: "text-to-image",
	},
	{
		value: "image-editing",
		label: "Image editing",
		pipelineTag: "image-to-image",
	},
	{
		value: "image-classification",
		label: "Image classification",
		pipelineTag: "image-classification",
	},
	{
		value: "object-detection",
		label: "Object detection",
		pipelineTag: "object-detection",
	},
	{
		value: "image-segmentation",
		label: "Image segmentation",
		pipelineTag: "image-segmentation",
	},
	{
		value: "text-to-video",
		label: "Text to video",
		pipelineTag: "text-to-video",
	},
	{
		value: "image-to-video",
		label: "Image to video",
		pipelineTag: "image-to-video",
	},
	{
		value: "video-classification",
		label: "Video understanding",
		pipelineTag: "video-classification",
	},
	{
		value: "embedding",
		label: "Embedding / similarity",
		pipelineTag: "sentence-similarity",
	},
	{
		value: "feature-extraction",
		label: "Embeddings / features",
		pipelineTag: "feature-extraction",
	},
	{ value: "reranker", label: "Reranker", pipelineTag: "text-ranking" },
	{
		value: "stt",
		label: "Speech to text",
		pipelineTag: "automatic-speech-recognition",
	},
	{ value: "tts", label: "Text to speech", pipelineTag: "text-to-speech" },
	{
		value: "audio-generation",
		label: "Audio generation",
		pipelineTag: "text-to-audio",
	},
	{
		value: "audio-conversion",
		label: "Audio to audio",
		pipelineTag: "audio-to-audio",
	},
	{
		value: "audio-classification",
		label: "Audio understanding",
		pipelineTag: "audio-classification",
	},
	{
		value: "voice-activity-detection",
		label: "Voice activity detection",
		pipelineTag: "voice-activity-detection",
	},
	{
		value: "text-classification",
		label: "Text classification",
		pipelineTag: "text-classification",
	},
	{
		value: "question-answering",
		label: "Question answering",
		pipelineTag: "question-answering",
	},
	{
		value: "translation",
		label: "Translation",
		pipelineTag: "translation",
	},
	{
		value: "summarization",
		label: "Summarization",
		pipelineTag: "summarization",
	},
] as const;

export type ModelCategory = (typeof MODEL_CATEGORY_OPTIONS)[number]["value"];

/** Plain-language device-fit verdict, worst → best. `no_space` and `too_big`
 *  block the install (Core refuses it); `cpu` and `partial` run but slowly. The
 *  shared ranking lives in `@ryu/blocks/desktop/model-fit.ts`. */
export type FitVerdict =
	| "no_space"
	| "too_big"
	| "cpu"
	| "partial"
	| "ok"
	| "great"
	| "unknown";

/** One selectable model catalog source (Hugging Face + mirrors). */
export interface ModelCatalogSource {
	displayName: string;
	id: string;
}

/** A model row in the left-hand selector / detail header. */
export interface ModelCard {
	architecture: string | null;
	author: string;
	compatible: boolean;
	contextLength: number | null;
	createdAt: string | null;
	downloads: number;
	format: ModelFormat;
	gated: boolean;
	id: string;
	installed: boolean;
	lastModified: string | null;
	likes: number;
	name: string;
	needsEngine: string | null;
	params: number | null;
	pipelineTag: string | null;
	tags: string[];
}

/** One downloadable file of a model (a GGUF quantization). */
export interface ModelFile {
	filename: string;
	fit: FitVerdict;
	fitLabel: string;
	installed: boolean;
	quant: string | null;
	sizeBytes: number | null;
	sizeHuman: string;
}

/** Independent benchmark stats from Artificial Analysis (when available). */
export interface AaStats {
	intelligenceIndex: number | null;
	matchedName: string;
	outputTokensPerSecond: number | null;
	priceUsdPer1m: number | null;
	timeToFirstTokenS: number | null;
}

/** Detected hardware the fit verdicts were computed against — always the Core
 *  node serving the request, which may be remote. */
export interface DeviceInfo {
	/** Free bytes on the volume holding the node's models directory. */
	diskFreeBytes?: number | null;
	/** Human free-disk size (e.g. "120.4 GB"); empty when unknown. */
	diskFreeHuman?: string;
	gpuName: string | null;
	os: string;
	ramHuman: string;
	totalRamBytes?: number | null;
	unifiedMemory: boolean;
	vramBytes: number | null;
	vramHuman: string;
}

/** Full right-hand detail payload for a selected model. */
export interface ModelDetail {
	card: ModelCard;
	device: DeviceInfo;
	files: ModelFile[];
	format: ModelFormat;
	readme: string | null;
	/** Machine-readable snapshot fit verdict; empty for GGUF or an older Core. */
	repoFit?: string;
	repoFitLabel: string;
	repoSizeBytes: number | null;
	stats: AaStats | null;
	statsApiKeyPresent: boolean;
	vision: boolean;
}

/** One installed model by local stem; `finetuneBase` set only for merged fine-tunes. */
export interface InstalledModelEntry {
	finetuneBase: string | null;
	stem: string;
}

/** On-demand llmfit hardware fit + tok/s estimate for one model. */
export interface LlmFitEstimate {
	fit_level: string | null;
	installed: boolean;
	matched: boolean;
	min_vram_gb: number | null;
	path: string | null;
	tps: number | null;
}

/** What the Models section consumes from its injected data hook. */
export interface ModelCatalogState {
	activeSource: string;
	browseOrg: (o: string) => void;
	category: ModelCategory;
	detail: ModelDetail | null;
	detailError: string | null;
	detailLoading: boolean;
	error: string | null;
	fetchNextPage: () => void;
	format: ModelFormat;
	hasNextPage: boolean;
	install: (file: string) => Promise<void>;
	installedOnly: boolean;
	installing: string | null;
	installingSnapshot: boolean;
	installSnapshot: () => Promise<void>;
	loading: boolean;
	loadingMore: boolean;
	models: ModelCard[];
	org: string;
	query: string;
	select: (id: string) => void;
	selectedId: string | null;
	selectingSource: boolean;
	selectSource: (id: string) => void;
	setCategory: (c: ModelCategory) => void;
	setFormat: (f: ModelFormat) => void;
	setInstalledOnly: (v: boolean) => void;
	setOrg: (o: string) => void;
	setQuery: (q: string) => void;
	setSort: (s: ModelSort) => void;
	sort: ModelSort;
	sources: ModelCatalogSource[];
	uninstall: (file: string) => Promise<void>;
	uninstalling: string | null;
}
