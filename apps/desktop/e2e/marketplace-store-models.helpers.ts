import type { Route } from "@playwright/test";
import type { useTabsContext } from "../src/contexts/TabsContext.tsx";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for marketplace-store-models.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

export type OpenTabOptions = NonNullable<
	Parameters<ReturnType<typeof useTabsContext>["openTab"]>[1]
>;

export const STORY_URL = "/marketplace-store-models.html";
export const BASE_URL = `http://127.0.0.1:${process.env.RYU_MARKETPLACE_STORE_MODELS_PORT ?? "5190"}`;
export const FILTER_PROOF_DIR = proofEvidencePath(
	"marketplace-model-filters-20261002"
);

declare global {
	interface Window {
		__modelsStoreEffects?: {
			openedTabOptions: OpenTabOptions[];
			openedTabs: string[];
		};
	}
}
export const TOKEN_TAGS = [
	"Instruct",
	"Chat",
	"Base",
	"Reasoning",
	"R1",
	"Chain-of-Thought",
	"Multi-Token",
	"Uncensored",
	"Quality-Tuned",
	"Fine-Tuned",
	"Distilled",
	"Merged",
	"Vision",
	"Coder",
	"Math",
	"Mixture-of-Experts",
	"Full precision",
	"GGUF",
	"Other format",
	"Preview",
	"Long context",
];

export interface RequestRecord {
	body: unknown;
	method: string;
	path: string;
	search: string;
}

export interface ModelWire {
	architecture: string | null;
	author: string;
	compatible: boolean;
	context_length: number | null;
	created_at: string;
	downloads: number;
	format: "gguf" | "safetensors" | "mlx";
	gated: boolean;
	id: string;
	last_modified: string;
	likes: number;
	name: string;
	needs_engine: string | null;
	params: number | null;
	pipeline_tag: string;
	tags: string[];
}

export interface FileWire {
	filename: string;
	fit: "great" | "ok" | "partial" | "too_big";
	fit_label: string;
	installed?: boolean;
	quant: string | null;
	size_bytes: number;
	size_human: string;
	url: string;
}

export interface Fixture {
	activeFailures: number;
	activeModel: string;
	activeSource: string;
	calls: RequestRecord[];
	communityMirrorSource: string;
	detailFailures: number;
	engineInstallReads: number;
	engineInstallState: "installed" | "installing" | "not_installed";
	files: Record<string, FileWire[]>;
	installedFiles: Set<string>;
	installedSnapshots: Set<string>;
	installFailures: number;
	installGate: Promise<void> | null;
	llmfitFailures: number;
	modelListFailures: number;
	models: ModelWire[];
	paginationEnabled: boolean;
	publishedLlmfit: boolean;
	releaseInstall?: () => void;
	sidecarFailures: number;
	snapshotFailures: number;
	uninstallFailures: number;
}

export const tokenCatalogTags = [
	"instruct",
	"chat",
	"base",
	"reasoning",
	"r1",
	"cot",
	"mtp",
	"dolphin",
	"qat",
	"dpo",
	"distilled",
	"merged",
	"vision",
	"coder",
	"math",
	"moe",
	"bf16",
	"gguf",
	"safetensors",
	"preview",
	"128k",
];

export function model(
	id: string,
	name: string,
	author: string,
	format: ModelWire["format"],
	pipelineTag: string,
	options: Partial<ModelWire> = {}
): ModelWire {
	return {
		architecture: "fixture-transformer",
		author,
		compatible: true,
		context_length: 32_768,
		created_at: "2026-02-01T00:00:00Z",
		downloads: 100,
		format,
		gated: false,
		id,
		last_modified: "2026-08-01T00:00:00Z",
		likes: 20,
		name,
		needs_engine: null,
		params: 4_000_000_000,
		pipeline_tag: pipelineTag,
		tags: [],
		...options,
	};
}

export const initialModels = [
	model(
		"google/gemma-4b-instruct",
		"Gemma-4B-Instruct",
		"google",
		"gguf",
		"text-generation",
		{ downloads: 900, tags: ["chat", "instruct", "text-generation"] }
	),
	model(
		"meta/llama-8b-chat",
		"Llama-8B-Chat",
		"meta",
		"gguf",
		"text-generation",
		{ downloads: 700, likes: 90, tags: ["chat", "gguf"] }
	),
	model(
		"meta/llama-8b-vision",
		"Llama-8B-Vision",
		"meta",
		"gguf",
		"image-text-to-text",
		{ downloads: 400, tags: ["vision", "chat"] }
	),
	model(
		"acme/embed-2b",
		"Embed-2B",
		"acme",
		"safetensors",
		"sentence-similarity",
		{ downloads: 300, tags: ["embedding"] }
	),
	model(
		"acme/embed-1b-gguf",
		"Embed-1B-GGUF",
		"acme",
		"gguf",
		"sentence-similarity",
		{ downloads: 180, tags: ["embedding", "gguf"] }
	),
	model("cohere/reranker-3b", "Reranker-3B", "cohere", "gguf", "text-ranking", {
		downloads: 200,
		tags: ["reranker"],
	}),
	model(
		"openai/whisper-1b",
		"Whisper-1B",
		"openai",
		"gguf",
		"automatic-speech-recognition",
		{ downloads: 500, tags: ["speech", "audio"] }
	),
	model(
		"audio/voice-tts-2b",
		"Voice-TTS-2B",
		"audio",
		"gguf",
		"text-to-speech",
		{ downloads: 250, tags: ["audio"] }
	),
	model(
		"salesforce/caption-2b",
		"Caption-2B",
		"salesforce",
		"gguf",
		"image-to-text"
	),
	model(
		"stability/flux-gguf",
		"Flux-GGUF",
		"stability",
		"gguf",
		"text-to-image"
	),
	model(
		"black-forest-labs/edit-gguf",
		"Edit-GGUF",
		"black-forest-labs",
		"gguf",
		"image-to-image"
	),
	model(
		"microsoft/image-classifier",
		"Image-Classifier",
		"microsoft",
		"gguf",
		"image-classification"
	),
	model(
		"facebook/detector-gguf",
		"Detector-GGUF",
		"facebook",
		"gguf",
		"object-detection"
	),
	model(
		"sam/segmenter-gguf",
		"Segmenter-GGUF",
		"sam",
		"gguf",
		"image-segmentation"
	),
	model(
		"kling/video-gen-gguf",
		"Video-Gen-GGUF",
		"kling",
		"gguf",
		"text-to-video"
	),
	model(
		"luma/image-video-gguf",
		"Image-Video-GGUF",
		"luma",
		"gguf",
		"image-to-video"
	),
	model(
		"microsoft/video-classifier",
		"Video-Classifier",
		"microsoft",
		"gguf",
		"video-classification"
	),
	model(
		"nomic/feature-embed-gguf",
		"Feature-Embed-GGUF",
		"nomic",
		"gguf",
		"feature-extraction"
	),
	model("audio/music-gguf", "Music-GGUF", "audio", "gguf", "text-to-audio"),
	model(
		"coqui/audio-convert-gguf",
		"Audio-Convert-GGUF",
		"coqui",
		"gguf",
		"audio-to-audio"
	),
	model(
		"speechbrain/audio-classifier",
		"Audio-Classifier",
		"speechbrain",
		"gguf",
		"audio-classification"
	),
	model(
		"silero/vad-gguf",
		"VAD-GGUF",
		"silero",
		"gguf",
		"voice-activity-detection"
	),
	model(
		"distilbert/text-classifier",
		"Text-Classifier",
		"distilbert",
		"gguf",
		"text-classification"
	),
	model("deepset/qa-gguf", "QA-GGUF", "deepset", "gguf", "question-answering"),
	model(
		"facebook/translator-gguf",
		"Translator-GGUF",
		"facebook",
		"gguf",
		"translation"
	),
	model(
		"pegasus/summarizer-gguf",
		"Summarizer-GGUF",
		"pegasus",
		"gguf",
		"summarization"
	),
	model(
		"apple/mlx-llama-8b",
		"Llama-8B-MLX",
		"apple",
		"mlx",
		"text-generation",
		{
			compatible: false,
			needs_engine: "MLX (Apple Silicon)",
			tags: ["chat", "mlx"],
		}
	),
	model(
		"restricted/gated-4b",
		"Gated-4B-Instruct",
		"restricted",
		"gguf",
		"text-generation",
		{ gated: true, tags: ["instruct"] }
	),
	model(
		"fixture/token-catalog",
		"Token-Catalog-4B",
		"fixture",
		"gguf",
		"text-generation",
		{ tags: tokenCatalogTags }
	),
	model(
		"mirror/falcon-4b-instruct",
		"Falcon-4B-Instruct",
		"mirror",
		"gguf",
		"text-generation",
		{ downloads: 600, tags: ["instruct", "chat"] }
	),
];

export const ggufFiles: FileWire[] = [
	{
		filename: "gemma-4b-instruct-Q4_K_M.gguf",
		fit: "great",
		fit_label: "Fits your device",
		quant: "Q4_K_M",
		size_bytes: 2_500_000_000,
		size_human: "2.5 GB",
		url: "https://fixture.invalid/gemma-q4.gguf",
	},
	{
		filename: "gemma-4b-instruct-Q8_0.gguf",
		fit: "ok",
		fit_label: "Fits with room to spare",
		quant: "Q8_0",
		size_bytes: 5_000_000_000,
		size_human: "5.0 GB",
		url: "https://fixture.invalid/gemma-q8.gguf",
	},
	{
		filename: "mmproj-model-f16.gguf",
		fit: "partial",
		fit_label: "Optional image adapter",
		quant: null,
		size_bytes: 500_000_000,
		size_human: "500 MB",
		url: "https://fixture.invalid/mmproj.gguf",
	},
	{
		filename: "gemma-draft-Q5_K_M.gguf",
		fit: "partial",
		fit_label: "Optional draft head",
		quant: null,
		size_bytes: 900_000_000,
		size_human: "900 MB",
		url: "https://fixture.invalid/draft.gguf",
	},
];

export function makeFixture(): Fixture {
	return {
		activeFailures: 0,
		activeModel: "meta/llama-8b-chat",
		activeSource: "huggingface",
		calls: [],
		communityMirrorSource: "local-mirror",
		engineInstallReads: 0,
		engineInstallState: "installed",
		detailFailures: 0,
		files: {
			"google/gemma-4b-instruct": structuredClone(ggufFiles),
			"meta/llama-8b-chat": structuredClone(ggufFiles),
			"meta/llama-8b-vision": structuredClone(ggufFiles),
			"restricted/gated-4b": structuredClone(ggufFiles),
			"fixture/token-catalog": structuredClone(ggufFiles),
			"mirror/falcon-4b-instruct": structuredClone(ggufFiles),
		},
		installFailures: 0,
		installGate: null,
		llmfitFailures: 0,
		modelListFailures: 0,
		models: structuredClone(initialModels),
		paginationEnabled: false,
		publishedLlmfit: false,
		sidecarFailures: 0,
		snapshotFailures: 0,
		uninstallFailures: 0,
		installedFiles: new Set([
			"meta/llama-8b-chat:gemma-4b-instruct-Q4_K_M.gguf",
			"google/gemma-4b-instruct:gemma-4b-instruct-Q4_K_M.gguf",
		]),
		installedSnapshots: new Set(),
	};
}

export const installedKey = (id: string, file: string) => `${id}:${file}`;

export function isModelInstalled(fixture: Fixture, id: string): boolean {
	return (
		fixture.installedSnapshots.has(id) ||
		[...fixture.installedFiles].some((key) => key.startsWith(`${id}:`))
	);
}

export function cardFor(fixture: Fixture, source: ModelWire): ModelWire {
	return { ...source, installed: isModelInstalled(fixture, source.id) };
}

export async function json<FixturePayload>(
	route: Route,
	status: number,
	body: FixturePayload
) {
	await route.fulfill({
		body: JSON.stringify(body),
		contentType: "application/json",
		status,
	});
}

export async function bodyOf(route: Route) {
	try {
		return route.request().postDataJSON();
	} catch {
		return undefined;
	}
}

export function listFor(
	fixture: Fixture,
	params: URLSearchParams
): ModelWire[] {
	let results = fixture.models.filter(
		(entry) =>
			(entry.format ?? "gguf") === (params.get("format") ?? "gguf") &&
			(fixture.activeSource !== fixture.communityMirrorSource ||
				entry.author === "mirror")
	);
	const query = params.get("query")?.toLowerCase();
	if (query) {
		results = results.filter((entry) =>
			[entry.id, entry.name, entry.author, ...entry.tags]
				.join(" ")
				.toLowerCase()
				.includes(query)
		);
	}
	const task = params.get("task");
	if (task) {
		results = results.filter((entry) => entry.pipeline_tag === task);
	}
	const author = params.get("author");
	if (author) {
		results = results.filter((entry) => entry.author === author);
	}
	if (params.get("installed_only") === "true") {
		results = results.filter((entry) => isModelInstalled(fixture, entry.id));
	}
	const sort = params.get("sort");
	if (sort === "downloads") {
		results = [...results].sort((a, b) => b.downloads - a.downloads);
	} else if (sort === "likes") {
		results = [...results].sort((a, b) => b.likes - a.likes);
	} else if (sort === "recent") {
		results = [...results].sort((a, b) =>
			(b.last_modified ?? "").localeCompare(a.last_modified ?? "")
		);
	}
	return results;
}
