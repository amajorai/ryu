import type { useTabsContext } from "../src/contexts/TabsContext.tsx";

type OpenTabOptions = NonNullable<
	Parameters<ReturnType<typeof useTabsContext>["openTab"]>[1]
>;

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, type Route, test } from "@playwright/test";

const STORY_URL = "/marketplace-store-models.html";
const BASE_URL = `http://127.0.0.1:${process.env.RYU_MARKETPLACE_STORE_MODELS_PORT ?? "5190"}`;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FILTER_PROOF_DIR = resolve(
	REPO_ROOT,
	"docs/proof/marketplace-model-filters-20261002"
);

declare global {
	interface Window {
		__modelsStoreEffects?: {
			openedTabOptions: OpenTabOptions[];
			openedTabs: string[];
		};
	}
}
const TOKEN_TAGS = [
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

interface RequestRecord {
	body: unknown;
	method: string;
	path: string;
	search: string;
}

interface ModelWire {
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

interface FileWire {
	filename: string;
	fit: "great" | "ok" | "partial" | "too_big";
	fit_label: string;
	installed?: boolean;
	quant: string | null;
	size_bytes: number;
	size_human: string;
	url: string;
}

interface Fixture {
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

const tokenCatalogTags = [
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

function model(
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

const initialModels = [
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

const ggufFiles: FileWire[] = [
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

function makeFixture(): Fixture {
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

const installedKey = (id: string, file: string) => `${id}:${file}`;

function isModelInstalled(fixture: Fixture, id: string): boolean {
	return (
		fixture.installedSnapshots.has(id) ||
		[...fixture.installedFiles].some((key) => key.startsWith(`${id}:`))
	);
}

function cardFor(fixture: Fixture, source: ModelWire): ModelWire {
	return { ...source, installed: isModelInstalled(fixture, source.id) };
}

async function json<FixturePayload>(
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

async function bodyOf(route: Route) {
	try {
		return route.request().postDataJSON();
	} catch {
		return undefined;
	}
}

function listFor(fixture: Fixture, params: URLSearchParams): ModelWire[] {
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

async function installModelFixture(page: Page): Promise<Fixture> {
	const fixture = makeFixture();
	await page.addInitScript(() => {
		localStorage.setItem("ryu_session_token", "local-model-fixture");
	});
	await page.route(`${BASE_URL}/api/**`, async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const method = request.method();
		const body = await bodyOf(route);
		fixture.calls.push({
			body,
			method,
			path: url.pathname,
			search: url.search,
		});

		if (url.pathname === "/api/catalog/sources" && method === "GET") {
			await json(route, 200, {
				active: fixture.activeSource,
				sources: [
					{ builtin: true, display_name: "Hugging Face", id: "huggingface" },
					{
						builtin: false,
						base_url: "https://models.example.test",
						display_name: "Local mirror",
						id: fixture.communityMirrorSource,
					},
				],
			});
			return;
		}
		if (url.pathname === "/api/catalog/sources/select" && method === "POST") {
			// SAFETY: The mounted model source selector passes a fixture source string ID through useModelCatalog to selectModelSource, whose request serializes { id, kind } into this controlled POST.
			fixture.activeSource = (body as { id: string }).id;
			await json(route, 200, { success: true });
			return;
		}
		if (url.pathname === "/api/catalog" && method === "GET") {
			const installState = fixture.engineInstallState;
			if (installState === "installing") {
				fixture.engineInstallReads += 1;
				fixture.engineInstallState = "installed";
			}
			await json(route, 200, {
				sidecars: [
					{
						category: "provider",
						deprecated: false,
						description: "Local text inference",
						display_name: "llama.cpp",
						install_state: installState,
						installed_version: installState === "installed" ? "fixture" : null,
						latest_version: "fixture",
						name: "llamacpp",
						platforms: [],
						recommended: true,
						supported: true,
						update_available: false,
					},
				],
			});
			return;
		}
		if (url.pathname === "/api/models/engines" && method === "GET") {
			await json(route, 200, {
				formats: [
					{
						engines: [{ name: "llamacpp", supported: true }],
						format: "gguf",
						supported: true,
					},
				],
				resident: "llamacpp",
			});
			return;
		}
		if (url.pathname === "/api/setup/llamacpp/install" && method === "POST") {
			fixture.engineInstallState = "installing";
			fixture.engineInstallReads = 0;
			// Core's accepted-install reply: the force flag it honored and the
			// background-install notice the native setup contract requires.
			await json(route, 200, {
				success: true,
				forced: url.searchParams.get("force") === "true",
				message: "Sidecar 'llamacpp' installation started in background",
			});
			return;
		}
		if (url.pathname === "/api/models/catalog" && method === "GET") {
			if (fixture.modelListFailures > 0) {
				fixture.modelListFailures -= 1;
				await json(route, 503, { error: "Model catalog fixture is offline" });
				return;
			}
			const params = url.searchParams;
			const results = listFor(fixture, params);
			if (fixture.paginationEnabled) {
				const cursor = params.get("cursor");
				const page = cursor ? results.slice(4) : results.slice(0, 4);
				await json(route, 200, {
					models: page.map((entry) => cardFor(fixture, entry)),
					next_cursor: !cursor && results.length > 4 ? "page-two" : null,
					total: results.length,
				});
				return;
			}
			await json(route, 200, {
				models: results.map((entry) => cardFor(fixture, entry)),
				next_cursor: null,
				total: results.length,
			});
			return;
		}
		if (url.pathname === "/api/models/catalog/detail" && method === "GET") {
			if (fixture.detailFailures > 0) {
				fixture.detailFailures -= 1;
				await json(route, 503, { error: "Model detail fixture is offline" });
				return;
			}
			const id = url.searchParams.get("id") ?? "";
			const format = url.searchParams.get("format") ?? "gguf";
			const modelEntry = fixture.models.find((entry) => entry.id === id);
			if (!modelEntry) {
				await json(route, 404, { error: "Unknown model fixture" });
				return;
			}
			const modelCard = cardFor(fixture, modelEntry);
			const snapshot = format !== "gguf";
			await json(route, 200, {
				card: modelCard,
				device: {
					gpu_name: "Fixture GPU",
					os: "linux",
					ram_human: "64 GB",
					total_ram_bytes: 64_000_000_000,
					unified_memory: false,
					vram_bytes: 24_000_000_000,
					vram_human: "24 GB",
				},
				files: snapshot
					? []
					: (fixture.files[id] ?? []).map((file) => ({
							...file,
							installed: fixture.installedFiles.has(
								installedKey(id, file.filename)
							),
						})),
				format,
				readme:
					"Fixture model notes. See [the local usage guide](https://docs.example.test/model-usage).",
				repo_fit: "great",
				repo_fit_label: "Fits the fixture device.",
				repo_size_bytes: snapshot ? 7_200_000_000 : null,
				stats_api_key_present: false,
				vision: id === "meta/llama-8b-vision",
			});
			return;
		}
		if (url.pathname === "/api/models/catalog/install" && method === "POST") {
			// SAFETY: The mounted native model catalog calls installModelFile/installModelSnapshot with selected fixture string IDs and file/format strings; previewModelInstall adds only literal true dryRun before native request JSON serialization.
			const payload = body as {
				dryRun?: boolean;
				file?: string;
				format?: string;
				id: string;
			};
			if (payload.dryRun) {
				await json(route, 200, {
					action: "install",
					dryRun: true,
					success: true,
				});
				return;
			}
			if (payload.file) {
				if (fixture.installFailures > 0) {
					const gate = fixture.installGate;
					fixture.installGate = null;
					if (gate) {
						await gate;
					}
					fixture.installFailures -= 1;
					await json(route, 200, {
						error: "Fixture model transfer failed",
						success: false,
					});
					return;
				}
				fixture.installedFiles.add(installedKey(payload.id, payload.file));
				await json(route, 200, {
					result: {
						filename: payload.file,
						path: `/fixture/models/${payload.id}/${payload.file}`,
						repo_id: payload.id,
					},
					success: true,
				});
				return;
			}
			if (fixture.snapshotFailures > 0) {
				fixture.snapshotFailures -= 1;
				await json(route, 200, {
					error: "Fixture snapshot transfer failed",
					success: false,
				});
				return;
			}
			fixture.installedSnapshots.add(payload.id);
			await json(route, 200, {
				result: {
					filename: "snapshot",
					path: `/fixture/models/${payload.id}`,
					repo_id: payload.id,
				},
				success: true,
			});
			return;
		}
		if (url.pathname === "/api/models/catalog/uninstall" && method === "POST") {
			// SAFETY: The mounted native file remove action calls uninstallModelFile with selected fixture string ID and filename; previewModelUninstall uses the same fields plus literal true dryRun before native JSON serialization.
			const payload = body as { dryRun?: boolean; file: string; id: string };
			if (payload.dryRun) {
				await json(route, 200, {
					action: "uninstall",
					dryRun: true,
					success: true,
				});
				return;
			}
			if (fixture.uninstallFailures > 0) {
				fixture.uninstallFailures -= 1;
				await json(route, 200, {
					error: "Fixture model removal failed",
					success: false,
				});
				return;
			}
			fixture.installedFiles.delete(installedKey(payload.id, payload.file));
			await json(route, 200, { success: true });
			return;
		}
		if (url.pathname === "/api/models/active" && method === "GET") {
			await json(route, 200, {
				active: fixture.activeModel,
				default: "meta/llama-8b-chat",
				engine: "llama.cpp",
				format: "gguf",
				ref: fixture.activeModel,
				repo_id: fixture.activeModel,
			});
			return;
		}
		if (url.pathname === "/api/models/active" && method === "POST") {
			if (fixture.activeFailures > 0) {
				fixture.activeFailures -= 1;
				await json(route, 200, {
					error: "Fixture engine is temporarily unavailable",
					success: false,
				});
				return;
			}
			// SAFETY: The mounted ActiveModelControl passes the selected fixture string repository ID to setActiveModel; its native request serializes that id into this controlled POST.
			fixture.activeModel = (body as { id: string }).id;
			await json(route, 200, {
				active: fixture.activeModel,
				engine: "llama.cpp",
				format: "gguf",
				gateway_refreshed: true,
				restarted: false,
				success: true,
				swapped: true,
			});
			return;
		}
		if (url.pathname === "/api/models/llmfit-estimate" && method === "GET") {
			if (fixture.llmfitFailures > 0) {
				fixture.llmfitFailures -= 1;
				await json(route, 503, { error: "Fixture speed estimator offline" });
				return;
			}
			await json(route, 200, {
				fit_level: "great",
				installed: fixture.publishedLlmfit,
				matched: fixture.publishedLlmfit,
				min_vram_gb: 12,
				model_name: "Fixture Gemma",
				path: "fixture_catalog",
				tps: 42,
			});
			return;
		}
		if (url.pathname === "/api/setup/llmfit/install" && method === "POST") {
			if (fixture.sidecarFailures > 0) {
				fixture.sidecarFailures -= 1;
				await json(route, 200, {
					error: "Fixture speed estimator install failed",
					success: false,
				});
				return;
			}
			fixture.publishedLlmfit = true;
			await json(route, 200, {
				success: true,
				forced: url.searchParams.get("force") === "true",
				message: "Sidecar 'llmfit' installation started in background",
			});
			return;
		}
		if (url.pathname === "/api/models/installed" && method === "GET") {
			await json(route, 200, { models: [] });
			return;
		}
		await json(route, 200, {});
	});
	return fixture;
}

function modelSearchCalls(fixture: Fixture): RequestRecord[] {
	return fixture.calls.filter(
		(call) => call.path === "/api/models/catalog" && call.method === "GET"
	);
}

function latestSearch(fixture: Fixture): URLSearchParams {
	const call = modelSearchCalls(fixture).at(-1);
	return new URLSearchParams(call?.search ?? "");
}

async function chooseSelectOption(
	page: Page,
	index: number,
	optionName: string
): Promise<void> {
	await page.getByRole("combobox").nth(index).click();
	await page.getByRole("option", { name: optionName, exact: true }).click();
}

async function openFilters(page: Page): Promise<void> {
	const filters = page.getByRole("button", { name: "Filters", exact: true });
	if ((await filters.getAttribute("aria-expanded")) !== "true") {
		await filters.click();
	}
}

async function closeFilters(page: Page): Promise<void> {
	const filters = page.getByRole("button", { name: "Filters", exact: true });
	if ((await filters.getAttribute("aria-expanded")) === "true") {
		await filters.click();
	}
}

test.describe.configure({ timeout: 90_000 });

test("model source, every task/format/sort option, and exact Core queries stay in sync", async ({
	page,
}) => {
	const fixture = await installModelFixture(page);
	await page.goto(`${STORY_URL}?section=models`);
	await expect(page.getByRole("tab", { name: "Models" })).toHaveAttribute(
		"aria-selected",
		"true"
	);
	await openFilters(page);

	await chooseSelectOption(page, 0, "Local mirror");
	await expect.poll(() => fixture.activeSource).toBe("local-mirror");
	expect(
		fixture.calls
			.filter((call) => call.path === "/api/catalog/sources/select")
			.map((call) => call.body)
	).toEqual([{ kind: "model", id: "local-mirror" }]);
	await expect(page.getByRole("button", { name: /Falcon/ })).toBeVisible();
	await chooseSelectOption(page, 0, "Hugging Face");
	await expect.poll(() => fixture.activeSource).toBe("huggingface");

	const categories = [
		["Chat / text", "text-generation", "google"],
		["Vision", "image-text-to-text", "meta"],
		["Image to text", "image-to-text", "salesforce"],
		["Image generation", "text-to-image", "stability"],
		["Image editing", "image-to-image", "black-forest-labs"],
		["Image classification", "image-classification", "microsoft"],
		["Object detection", "object-detection", "facebook"],
		["Image segmentation", "image-segmentation", "sam"],
		["Text to video", "text-to-video", "kling"],
		["Image to video", "image-to-video", "luma"],
		["Video understanding", "video-classification", "microsoft"],
		["Embedding / similarity", "sentence-similarity", "acme"],
		["Embeddings / features", "feature-extraction", "nomic"],
		["Reranker", "text-ranking", "cohere"],
		["Speech to text", "automatic-speech-recognition", "openai"],
		["Text to speech", "text-to-speech", "audio"],
		["Audio generation", "text-to-audio", "audio"],
		["Audio to audio", "audio-to-audio", "coqui"],
		["Audio understanding", "audio-classification", "speechbrain"],
		["Voice activity detection", "voice-activity-detection", "silero"],
		["Text classification", "text-classification", "distilbert"],
		["Question answering", "question-answering", "deepset"],
		["Translation", "translation", "facebook"],
		["Summarization", "summarization", "pegasus"],
	] as const;
	for (const [label, task, author] of categories) {
		await chooseSelectOption(page, 1, label);
		await expect.poll(() => latestSearch(fixture).get("task")).toBe(task);
		await expect(
			page.getByRole("button", { name: new RegExp(author) }).first()
		).toBeVisible();
	}
	await chooseSelectOption(page, 1, "All categories");
	await expect.poll(() => latestSearch(fixture).get("task")).toBeNull();
	await chooseSelectOption(page, 1, "Text to video");
	await expect
		.poll(() => latestSearch(fixture).get("task"))
		.toBe("text-to-video");
	await expect(page.getByRole("button", { name: /kling/ })).toBeVisible();
	await mkdir(FILTER_PROOF_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(FILTER_PROOF_DIR, "marketplace-video-filter.png"),
		fullPage: true,
	});
	await chooseSelectOption(page, 1, "All categories");

	const formats = [
		["Runs anywhere (GGUF)", "gguf", "google"],
		["Full quality (Safetensors)", "safetensors", "acme"],
		["Apple Silicon (MLX)", "mlx", "apple"],
	] as const;
	for (const [label, format, author] of formats) {
		await chooseSelectOption(page, 2, label);
		await expect.poll(() => latestSearch(fixture).get("format")).toBe(format);
		await expect(
			page.getByRole("button", { name: new RegExp(author) }).first()
		).toBeVisible();
	}
	await chooseSelectOption(page, 2, "Runs anywhere (GGUF)");

	const sorts = [
		["Trending", "trending"],
		["Popular", "downloads"],
		["Most liked", "likes"],
		["Newest", "recent"],
	] as const;
	for (const [label, sort] of sorts) {
		await chooseSelectOption(page, 3, label);
		await expect.poll(() => latestSearch(fixture).get("sort")).toBe(sort);
	}
});

test("the tag picker exposes and applies all 21 tokens with removable filter chips", async ({
	page,
}) => {
	const fixture = await installModelFixture(page);
	await page.goto(`${STORY_URL}?section=models`);
	await openFilters(page);
	await page.getByRole("button", { name: "Tags", exact: false }).click();
	const choices = page.getByRole("menuitemcheckbox");
	await expect(choices).toHaveCount(21);
	for (const label of TOKEN_TAGS) {
		const choice = page.getByRole("menuitemcheckbox", {
			name: label,
			exact: true,
		});
		await expect(choice).toBeVisible();
		await choice.click();
		await expect(choice).toHaveAttribute("aria-checked", "true");
	}
	await expect(
		page.getByRole("button", { name: /Token Catalog/ })
	).toBeVisible();
	await expect(page.getByRole("button", { name: /Gemma/ })).toHaveCount(0);
	const chips = page.getByRole("button", { name: /^Remove filter / });
	await expect(chips).toHaveCount(21);
	await page.getByRole("button", { name: /^Tags/ }).click();

	for (const label of [...TOKEN_TAGS].reverse()) {
		await page.getByRole("button", { name: `Remove filter ${label}` }).click();
		await page.getByRole("button", { name: /^Tags/ }).click();
		await expect(
			page.getByRole("menuitemcheckbox", { name: label, exact: true })
		).toHaveAttribute("aria-checked", "false");
		await page.getByRole("button", { name: /^Tags/ }).click();
	}
	await expect(chips).toHaveCount(0);
	await expect(page.getByRole("button", { name: /Gemma/ })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("menuitemcheckbox").first()).toHaveCount(0);
	expect(modelSearchCalls(fixture).length).toBeGreaterThan(0);
});

test("search, Added only, friendly labels, raw tags, and clear filters preserve their intended state", async ({
	page,
}) => {
	const fixture = await installModelFixture(page);
	await page.goto(`${STORY_URL}?section=models`);
	const search = page.getByPlaceholder(
		"Search by name, org, tag, or type (e.g. llama, google, coder, uncensored)…"
	);
	await expect(
		page.getByText("Chat-ready", { exact: true }).first()
	).toBeVisible();

	await openFilters(page);
	const friendly = page.getByRole("switch", {
		name: "Friendly names",
	});
	await expect(friendly).toHaveAttribute("aria-checked", "true");
	await friendly.click();
	await expect(
		page.getByText("Instruct", { exact: true }).first()
	).toBeVisible();
	await friendly.click();
	await expect(
		page.getByText("Chat-ready", { exact: true }).first()
	).toBeVisible();

	const showTags = page.getByRole("switch", { name: "Show tags" });
	await expect(showTags).toHaveAttribute("aria-checked", "false");
	await showTags.click();
	await expect(
		page.getByText("text-generation", { exact: true }).first()
	).toBeVisible();
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu.catalog.showTags"))
		)
		.toBe("true");

	await chooseSelectOption(page, 1, "Vision");
	await chooseSelectOption(page, 3, "Newest");
	const addedOnly = page.getByRole("switch", { name: "Added only" });
	await addedOnly.click();
	await expect(addedOnly).toHaveAttribute("aria-checked", "true");
	await expect(page.getByRole("combobox").nth(1)).toBeDisabled();
	await expect
		.poll(() => latestSearch(fixture).get("installed_only"))
		.toBe("true");

	await search.fill("no-such-model-in-local-fixture");
	await expect(
		page.getByText("No models added yet", { exact: true })
	).toBeVisible();
	await expect
		.poll(() => latestSearch(fixture).get("query"))
		.toBe("no-such-model-in-local-fixture");
	await page
		.getByRole("button", { name: "Clear filters", exact: true })
		.click();
	await expect(search).toHaveValue("");
	await expect(page.getByRole("button", { name: /Gemma/ })).toBeVisible();
	await expect.poll(() => latestSearch(fixture).get("format")).toBe("gguf");
	await expect.poll(() => latestSearch(fixture).get("sort")).toBe("trending");
	await expect(latestSearch(fixture).get("installed_only")).toBeNull();
	await expect(latestSearch(fixture).get("task")).toBeNull();

	await page.reload();
	await expect(
		page.getByText("text-generation", { exact: true }).first()
	).toBeVisible();
	await openFilters(page);
	await expect(page.getByRole("switch", { name: "Show tags" })).toHaveAttribute(
		"aria-checked",
		"true"
	);
	await expect(
		page.getByRole("switch", { name: "Friendly names" })
	).toHaveAttribute("aria-checked", "true");
});

test("the Store Installed toolbar button filters Models and restores the full catalog", async ({
	page,
}) => {
	const fixture = await installModelFixture(page);
	await page.goto(`${STORY_URL}?section=models`);
	const installed = page.getByRole("button", {
		name: "Installed",
		exact: true,
	});
	await expect(installed).toHaveAttribute("aria-pressed", "false");
	await expect(page.getByRole("button", { name: /Gated/ })).toBeVisible();
	await installed.click();
	await expect(installed).toHaveAttribute("aria-pressed", "true");
	await expect
		.poll(() => latestSearch(fixture).get("installed_only"))
		.toBe("true");
	await expect(page.getByRole("button", { name: /Gemma/ })).toBeVisible();
	await expect(page.getByRole("button", { name: /Gated/ })).toHaveCount(0);
	await installed.click();
	await expect(installed).toHaveAttribute("aria-pressed", "false");
	await expect
		.poll(() => latestSearch(fixture).get("installed_only"))
		.toBeNull();
	await expect(page.getByRole("button", { name: /Gated/ })).toBeVisible();
});

test("list loading retries, selection works by keyboard, infinite paging and split resize persist", async ({
	page,
}, testInfo) => {
	const fixture = await installModelFixture(page);
	fixture.modelListFailures = 1;
	await page.goto(`${STORY_URL}?section=models`);
	await expect(
		page.getByText("Couldn't load models", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText(/\/api\/models\/catalog\?.*failed: 503/)
	).toBeVisible();
	await page.getByRole("button", { name: "Try again", exact: true }).click();
	await expect(page.getByRole("button", { name: /Gemma/ })).toBeVisible();
	await expect(modelSearchCalls(fixture)).toHaveLength(2);

	const gemma = page.getByRole("button", { name: /Gemma/ });
	await gemma.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("heading", { name: /Gemma/ })).toBeVisible();
	await expect
		.poll(() =>
			fixture.calls.some(
				(call) =>
					call.path === "/api/models/catalog/detail" &&
					new URLSearchParams(call.search).get("id") ===
						"google/gemma-4b-instruct"
			)
		)
		.toBe(true);
	await page.screenshot({
		animations: "disabled",
		path: testInfo.outputPath("models-gemma-detail-rendered.png"),
	});

	const splitter = page.getByRole("separator");
	await expect(splitter).toBeVisible();
	await splitter.focus();
	await page.keyboard.press("ArrowRight");
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu.store.models.split"))
		)
		.toMatch(/"list":\d/);

	fixture.paginationEnabled = true;
	await page.reload();
	const list = page.locator("nav.scroll-fade").last();
	await list.evaluate((element) => element.scrollTo(0, element.scrollHeight));
	await expect
		.poll(() =>
			modelSearchCalls(fixture).some(
				(call) => new URLSearchParams(call.search).get("cursor") === "page-two"
			)
		)
		.toBe(true);
	await expect(
		page.getByRole("button", { name: /Token Catalog/ })
	).toBeVisible();
});

test("model-card and detail tooltips explain context, dates, size, token and addon badges", async ({
	page,
}, testInfo) => {
	// Pin "now" so the fixture's 2026-08-01 last_modified always reads as
	// "2 months ago" instead of drifting with the wall clock.
	await page.clock.setFixedTime(new Date("2026-10-01T00:00:00.000Z"));
	await installModelFixture(page);
	await page.goto(`${STORY_URL}?section=models`);
	const contextBadge = page
		.getByText("32,768 context", { exact: true })
		.first();
	await contextBadge.hover();
	await expect(
		page.getByText("Context window (tokens the model can read + write at once)")
	).toBeVisible();
	const updatedDate = page.getByText("(updated 2 months ago)").first();
	await updatedDate.hover();
	await expect(page.getByText("Updated Aug 1, 2026")).toBeVisible();

	await page.getByRole("button", { name: /Gemma/ }).click();
	await expect(page.getByRole("heading", { name: /Gemma/ })).toBeVisible();
	const sizeBadge = page.getByText("Medium", { exact: true }).last();
	await sizeBadge.hover();
	await expect(page.getByText("4 billion parameters")).toBeVisible();
	const tokenBadge = page.getByRole("button", {
		name: "Chat-ready",
		exact: true,
	});
	await tokenBadge.hover();
	await expect(
		page.getByText("Instruction-tuned — follows chat-style prompts")
	).toBeVisible();
	await page.getByText("Vision adapter", { exact: true }).hover();
	await expect(
		page.getByText(/An image-understanding add-on \(mmproj\)/)
	).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		path: testInfo.outputPath("models-detail-tooltip-content.png"),
	});
});

test("GGUF quant install failure recovers, readback enables activation, fine-tune and removal paths", async ({
	page,
}, testInfo) => {
	const fixture = await installModelFixture(page);
	fixture.installFailures = 1;
	fixture.uninstallFailures = 1;
	fixture.activeFailures = 1;
	fixture.llmfitFailures = 1;
	fixture.engineInstallState = "not_installed";
	fixture.installGate = new Promise<void>((resolve) => {
		fixture.releaseInstall = resolve;
	});
	await page.goto(`${STORY_URL}?section=models`);
	const gemma = page.getByRole("button", { name: /Gemma/ });
	await gemma.click();
	const detail = page.getByRole("heading", { name: /Gemma/ });
	await expect(detail).toBeVisible();
	const hfLink = page.getByRole("link", { name: "View on Hugging Face" });
	await expect(hfLink).toHaveAttribute(
		"href",
		"https://huggingface.co/google/gemma-4b-instruct"
	);
	await expect(hfLink).toHaveAttribute("target", "_blank");
	await expect(hfLink).toHaveAttribute("rel", "noopener noreferrer");
	const readmeLink = page.getByRole("link", { name: "the local usage guide" });
	await expect(readmeLink).toHaveAttribute(
		"href",
		"https://docs.example.test/model-usage"
	);
	await expect(readmeLink).toHaveAttribute("rel", "noopener noreferrer");

	const speed = page.getByRole("button", {
		name: "Estimate speed on your device",
		exact: true,
	});
	await speed.click();
	await expect(page.getByText(/llmfit-estimate.*failed: 503/)).toBeVisible();
	await page
		.getByRole("button", {
			name: "Estimate speed on your device",
			exact: true,
		})
		.click();
	await expect(
		page.getByRole("button", { name: "Enable speed estimates" })
	).toBeVisible();
	expect(
		fixture.calls
			.filter((call) => call.path === "/api/models/llmfit-estimate")
			.map((call) => new URLSearchParams(call.search).toString())
	).toEqual([
		"repo=google%2Fgemma-4b-instruct&context=32768&quant=Q8_0",
		"repo=google%2Fgemma-4b-instruct&context=32768&quant=Q8_0",
	]);

	fixture.sidecarFailures = 1;
	await page.getByRole("button", { name: "Enable speed estimates" }).click();
	await expect(
		page.getByText("Fixture speed estimator install failed")
	).toBeVisible();
	await page.getByRole("button", { name: "Enable speed estimates" }).click();
	await expect(
		fixture.calls.filter((call) => call.path === "/api/setup/llmfit/install")
	).toHaveLength(2);
	await page
		.getByRole("button", { name: "Estimate speed on your device" })
		.click();
	await expect(page.getByText("≈42 tokens/sec", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Re-estimate", exact: true }).click();
	await expect
		.poll(
			() =>
				fixture.calls.filter(
					(call) => call.path === "/api/models/llmfit-estimate"
				).length
		)
		.toBe(4);

	await openFilters(page);
	const tokenBadge = page.getByRole("button", {
		name: "Chat-ready",
		exact: true,
	});
	await tokenBadge.click();
	await expect(tokenBadge).toHaveAttribute("aria-pressed", "true");
	await openFilters(page);
	await expect(
		page.getByRole("button", { name: "Remove filter Instruct" })
	).toBeVisible();
	await page.keyboard.press("Escape");

	const author = page.getByRole("button", { name: "google", exact: true });
	await author.click();
	await expect.poll(() => latestSearch(fixture).get("author")).toBe("google");
	await openFilters(page);
	await expect(
		page.getByRole("button", { name: "Remove filter Org: google" })
	).toBeVisible();
	await closeFilters(page);

	const quant = page.getByRole("combobox").filter({ hasText: "Q8_0" });
	await quant.click();
	await page.getByRole("option", { name: /Q8_0/ }).click();
	const addQuant = page
		.getByRole("button", { name: "Add", exact: true })
		.first();
	await addQuant.click();
	await expect(
		page.getByRole("button", { name: "Adding…", exact: true })
	).toBeDisabled();
	await page.screenshot({
		animations: "disabled",
		path: testInfo.outputPath("models-q8-pending-remains-selected.png"),
	});
	// SAFETY: Only records for the native model install path enter this predicate; installModelFile/previewModelInstall serialize the selected fixture filename string when present, and snapshot installs omit it.
	await expect
		.poll(
			() =>
				fixture.calls.filter(
					(call) =>
						call.path === "/api/models/catalog/install" &&
						(call.body as { file?: string })?.file ===
							"gemma-4b-instruct-Q8_0.gguf"
				).length
		)
		.toBe(1);
	fixture.releaseInstall?.();
	await expect(
		page.getByRole("button", { name: "Add", exact: true }).first()
	).toBeVisible();
	await expect(
		fixture.installedFiles.has(
			"google/gemma-4b-instruct:gemma-4b-instruct-Q8_0.gguf"
		)
	).toBe(false);
	await page.getByRole("button", { name: "Add", exact: true }).first().click();
	await expect
		.poll(() =>
			fixture.installedFiles.has(
				"google/gemma-4b-instruct:gemma-4b-instruct-Q8_0.gguf"
			)
		)
		.toBe(true);
	const q8row = page.getByRole("listitem").filter({ hasText: "5.0 GB" });
	await page.mouse.move(100, 980);
	await expect(
		q8row.getByRole("button", { name: "Added", exact: true })
	).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		path: testInfo.outputPath("models-q8-installed-readback.png"),
	});
	const installRequests = fixture.calls.filter(
		(call) => call.path === "/api/models/catalog/install"
	);
	expect(installRequests.map((call) => call.body)).toEqual([
		{
			id: "google/gemma-4b-instruct",
			file: "gemma-4b-instruct-Q8_0.gguf",
			format: "gguf",
		},
		{
			id: "google/gemma-4b-instruct",
			file: "gemma-4b-instruct-Q8_0.gguf",
			format: "gguf",
		},
	]);
	const activate = page.getByRole("button", {
		name: "Set up & chat",
		exact: true,
	});
	await activate.click();
	await expect
		.poll(
			() =>
				fixture.calls.filter(
					(call) =>
						call.path === "/api/setup/llamacpp/install" &&
						call.method === "POST"
				).length
		)
		.toBe(1);
	await expect.poll(() => fixture.engineInstallReads).toBe(1);
	await expect
		.poll(
			() =>
				fixture.calls.filter(
					(call) => call.path === "/api/models/active" && call.method === "POST"
				).length
		)
		.toBe(1);
	await expect(
		page.getByRole("button", { name: "Use & chat", exact: true })
	).toBeEnabled();
	await page.getByRole("button", { name: "Use & chat", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Chat with this model", exact: true })
	).toBeEnabled();
	await expect
		.poll(() => page.evaluate(() => window.__modelsStoreEffects?.openedTabs))
		.toEqual(["/chat"]);
	const modelChatOptions = await page.evaluate(
		() => window.__modelsStoreEffects?.openedTabOptions?.[0]
	);
	expect(modelChatOptions).toMatchObject({
		forceNew: true,
		initialAgent: "ryu",
		initialModel: "google/gemma-4b-instruct",
		title: "Chat · Gemma",
	});
	await expect(
		page.getByRole("button", { name: /Could not start this model/ })
	).toBeHidden({ timeout: 10_000 });
	expect(
		fixture.calls
			.filter(
				(call) => call.path === "/api/models/active" && call.method === "POST"
			)
			.map((call) => call.body)
	).toEqual([
		{ engine: "llamacpp", id: "google/gemma-4b-instruct" },
		{ engine: "llamacpp", id: "google/gemma-4b-instruct" },
	]);
	expect(
		fixture.calls.filter(
			(call) =>
				call.path === "/api/setup/llamacpp/install" && call.method === "POST"
		)
	).toHaveLength(1);
	expect(fixture.engineInstallReads).toBe(1);
	await page.screenshot({
		animations: "disabled",
		path: testInfo.outputPath("models-active-model-chat-ready.png"),
	});
	await page.getByRole("button", { name: "Fine-tune", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => window.__modelsStoreEffects?.openedTabs))
		.toEqual([
			"/chat",
			"/plugin/@ryu/finetune?base_model_id=google%2Fgemma-4b-instruct",
		]);
	await page.screenshot({
		animations: "disabled",
		path: testInfo.outputPath("models-active-model-and-finetune.png"),
	});

	const remove = q8row.getByRole("button");
	await remove.focus();
	await expect(
		q8row.getByRole("button", { name: "Remove", exact: true })
	).toBeVisible();
	await q8row.getByRole("button", { name: "Remove", exact: true }).click();
	await expect
		.poll(
			() =>
				fixture.calls.filter(
					(call) => call.path === "/api/models/catalog/uninstall"
				).length
		)
		.toBe(1);
	await expect(
		fixture.installedFiles.has(
			"google/gemma-4b-instruct:gemma-4b-instruct-Q8_0.gguf"
		)
	).toBe(true);
	await q8row.getByRole("button", { name: "Remove", exact: true }).click();
	await expect
		.poll(() =>
			fixture.installedFiles.has(
				"google/gemma-4b-instruct:gemma-4b-instruct-Q8_0.gguf"
			)
		)
		.toBe(false);
	expect(
		fixture.calls
			.filter((call) => call.path === "/api/models/catalog/uninstall")
			.map((call) => call.body)
	).toEqual([
		{ id: "google/gemma-4b-instruct", file: "gemma-4b-instruct-Q8_0.gguf" },
		{ id: "google/gemma-4b-instruct", file: "gemma-4b-instruct-Q8_0.gguf" },
	]);

	const addon = page
		.getByRole("listitem")
		.filter({ hasText: "Vision adapter" });
	await addon.getByRole("button", { name: "Add", exact: true }).click();
	await expect
		.poll(() =>
			fixture.installedFiles.has(
				"google/gemma-4b-instruct:mmproj-model-f16.gguf"
			)
		)
		.toBe(true);
	await expect(
		addon.getByRole("button", { name: "Added", exact: true })
	).toBeVisible();
	expect(
		fixture.calls
			.filter((call) => call.path === "/api/models/catalog/install")
			.map((call) => call.body)
	).toEqual([
		{
			id: "google/gemma-4b-instruct",
			file: "gemma-4b-instruct-Q8_0.gguf",
			format: "gguf",
		},
		{
			id: "google/gemma-4b-instruct",
			file: "gemma-4b-instruct-Q8_0.gguf",
			format: "gguf",
		},
		{
			id: "google/gemma-4b-instruct",
			file: "mmproj-model-f16.gguf",
			format: "gguf",
		},
	]);
	await page.screenshot({
		animations: "disabled",
		path: testInfo.outputPath("models-installed-quant-and-addon.png"),
	});
});

test("snapshot models retry locally and incompatible MLX remains disabled", async ({
	page,
}, testInfo) => {
	const fixture = await installModelFixture(page);
	fixture.snapshotFailures = 1;
	await page.goto(`${STORY_URL}?section=models`);
	await openFilters(page);
	await chooseSelectOption(page, 2, "Full quality (Safetensors)");
	await closeFilters(page);
	const embed = page.getByRole("button", { name: /acme/ });
	await expect(embed).toBeVisible();
	await embed.click();
	await expect(page.getByRole("heading", { name: /Embed/ })).toBeVisible();
	const addRepository = page.getByRole("button", {
		name: "Add repository",
		exact: true,
	});
	await expect(page.getByText("7.2 GB", { exact: true })).toBeVisible();
	await addRepository.click();
	await expect(addRepository).toBeVisible();
	await addRepository.click();
	await expect
		.poll(() => fixture.installedSnapshots.has("acme/embed-2b"))
		.toBe(true);
	await expect(page.getByText("Added", { exact: true }).last()).toBeVisible();
	expect(
		fixture.calls
			.filter((call) => call.path === "/api/models/catalog/install")
			.map((call) => call.body)
	).toEqual([
		{ id: "acme/embed-2b", format: "safetensors" },
		{ id: "acme/embed-2b", format: "safetensors" },
	]);

	await openFilters(page);
	await chooseSelectOption(page, 2, "Apple Silicon (MLX)");
	await closeFilters(page);
	const mlx = page.getByRole("button", { name: /apple/ });
	await expect(mlx).toBeVisible();
	await mlx.click();
	await expect(page.getByRole("heading", { name: /Llama/ })).toBeVisible();
	await expect(page.getByText(/Requires MLX \(Apple Silicon\)/)).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Add repository" })
	).toBeDisabled();
	await page.screenshot({
		animations: "disabled",
		path: testInfo.outputPath("models-incompatible-mlx-action-disabled.png"),
	});
	// SAFETY: Only records for the native model install path enter this predicate; native install and preview writers JSON-serialize the selected fixture string repository ID.
	await expect
		.poll(
			() =>
				fixture.calls.filter(
					(call) =>
						call.path === "/api/models/catalog/install" &&
						(call.body as { id?: string })?.id === "apple/mlx-llama-8b"
				).length
		)
		.toBe(0);
});

test("gated model details keep their terms link on the exact safe Hugging Face destination", async ({
	page,
}) => {
	await installModelFixture(page);
	await page.goto(`${STORY_URL}?section=models`);
	await page.getByRole("button", { name: /restricted/ }).click();
	await expect(page.getByRole("heading", { name: /Gated/ })).toBeVisible();
	const link = page.getByRole("link", { name: "Hugging Face page" });
	await expect(link).toHaveAttribute(
		"href",
		"https://huggingface.co/restricted/gated-4b"
	);
	await expect(link).toHaveAttribute("target", "_blank");
	await expect(link).toHaveAttribute("rel", "noopener noreferrer");
});
