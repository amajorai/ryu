// apps/desktop/src/lib/api/models.ts
//
// Typed client for Core's model-catalog endpoints (`/api/models/*`). The catalog
// lets a user browse Hugging Face GGUF models, read each model's card, see which
// quantizations fit their device, and install one. ALL logic (search, sort,
// device-fit, stats, install) lives in Core — this module only shapes requests
// and parses responses, so the same Core powers the desktop, mobile, and
// extension surfaces identically.

import { track } from "@/src/lib/analytics.ts";
import { type ApiTarget, buyerTokenHeader, request } from "./client.ts";

/** How the catalog list is ordered. Mirrors Core's `CatalogSort`. */
export type ModelSort = "trending" | "downloads" | "likes" | "recent";

/**
 * Model weight format. Mirrors Core's `ModelFormat`. GGUF is a single quantized
 * file (llama.cpp/Ollama); safetensors (vLLM/SGLang) and MLX are multi-file repo
 * snapshots. The format determines which engine can serve the model.
 */
export type ModelFormat = "gguf" | "safetensors" | "mlx";

/** Every catalog format the desktop fans out across. */
export const MODEL_FORMATS: ModelFormat[] = ["gguf", "safetensors", "mlx"];

/**
 * Friendly model category shown in the filter. `"all"` applies no task filter;
 * every other value maps to a single Hugging Face `pipeline_tag` (see
 * {@link MODEL_CATEGORY_TASK}). HF accepts one tag, so this is single-select.
 */
export type ModelCategory =
	| "all"
	| "chat"
	| "vision"
	| "embedding"
	| "reranker"
	| "stt"
	| "tts";

/** Category → Hugging Face `pipeline_tag`. `"all"` means no filter. */
export const MODEL_CATEGORY_TASK: Record<ModelCategory, string> = {
	all: "",
	chat: "text-generation",
	vision: "image-text-to-text",
	embedding: "sentence-similarity",
	reranker: "text-ranking",
	stt: "automatic-speech-recognition",
	tts: "text-to-speech",
};

/** A model row in the left-hand selector. */
export interface ModelCard {
	/** Model architecture from GGUF metadata (e.g. "llama", "gemma3"). */
	architecture: string | null;
	author: string;
	/** Whether an engine that can serve `format` is runnable on this node. */
	compatible: boolean;
	/** Context window in tokens (the single prompt+completion budget). */
	contextLength: number | null;
	createdAt: string | null;
	downloads: number;
	/** Weight format this card was surfaced under (the query facet). */
	format: ModelFormat;
	gated: boolean;
	id: string;
	installed: boolean;
	lastModified: string | null;
	likes: number;
	name: string;
	/** Engine label needed for an incompatible card (e.g. "vLLM"); null when OK. */
	needsEngine: string | null;
	/** Parameter count from GGUF metadata (e.g. 8_000_000_000). */
	params: number | null;
	pipelineTag: string | null;
	tags: string[];
}

/** Plain-language device-fit verdict, worst → best. Mirrors Core's `FitVerdict`. */
export type FitVerdict =
	| "too_big"
	| "cpu"
	| "partial"
	| "ok"
	| "great"
	| "unknown";

/** One downloadable file of a model (a GGUF quantization). */
export interface ModelFile {
	filename: string;
	fit: FitVerdict;
	fitLabel: string;
	installed: boolean;
	quant: string | null;
	sha256: string | null;
	sizeBytes: number | null;
	sizeHuman: string;
	url: string;
}

/**
 * @deprecated Use {@link ModelFile}. Kept one release as an alias so external
 * imports don't break; `ModelFile` is the format-neutral name.
 */
export type GgufFile = ModelFile;

/** Independent benchmark stats from Artificial Analysis (when available). */
export interface AaStats {
	intelligenceIndex: number | null;
	matchedName: string;
	outputTokensPerSecond: number | null;
	priceUsdPer1m: number | null;
	timeToFirstTokenS: number | null;
}

/** Detected hardware the fit verdicts were computed against. */
export interface DeviceInfo {
	gpuName: string | null;
	os: string;
	ramHuman: string;
	totalRamBytes: number | null;
	unifiedMemory: boolean;
	vramBytes: number | null;
	vramHuman: string;
}

/** Full right-hand detail payload for a selected model. */
export interface ModelDetail {
	card: ModelCard;
	device: DeviceInfo;
	/** Per-quant files. Populated only for GGUF; empty for snapshot formats. */
	files: ModelFile[];
	/** Weight format of this detail view. */
	format: ModelFormat;
	readme: string | null;
	/** Coarse snapshot fit verdict; empty for GGUF. */
	repoFit: string;
	/** Conservative snapshot fit sentence (never "partial offload"); empty for GGUF. */
	repoFitLabel: string;
	/** Total snapshot repo size (summed shards); null for GGUF. */
	repoSizeBytes: number | null;
	stats: AaStats | null;
	statsApiKeyPresent: boolean;
	/**
	 * True when this GGUF repo ships a multimodal projector: installing any quant
	 * also auto-installs the matching vision adapter, and the served model accepts
	 * images. False for text-only and snapshot repos.
	 */
	vision: boolean;
}

// ── Wire shapes (snake_case from Core) ──────────────────────────────────────

interface CardWire {
	architecture?: string | null;
	author: string;
	compatible?: boolean;
	context_length?: number | null;
	created_at?: string | null;
	downloads?: number;
	format?: ModelFormat;
	gated?: boolean;
	id: string;
	installed?: boolean;
	last_modified?: string | null;
	likes?: number;
	name: string;
	needs_engine?: string | null;
	params?: number | null;
	pipeline_tag?: string | null;
	tags?: string[];
}

interface FileWire {
	filename: string;
	fit?: FitVerdict;
	fit_label?: string;
	installed?: boolean;
	quant?: string | null;
	sha256?: string | null;
	size_bytes?: number | null;
	size_human?: string;
	url: string;
}

interface StatsWire {
	intelligence_index?: number | null;
	matched_name?: string;
	output_tokens_per_second?: number | null;
	price_usd_per_1m?: number | null;
	time_to_first_token_s?: number | null;
}

interface DeviceWire {
	gpu_name?: string | null;
	os?: string;
	ram_human?: string;
	total_ram_bytes?: number | null;
	unified_memory?: boolean;
	vram_bytes?: number | null;
	vram_human?: string;
}

function toCard(w: CardWire): ModelCard {
	return {
		id: w.id,
		author: w.author,
		name: w.name,
		downloads: w.downloads ?? 0,
		likes: w.likes ?? 0,
		pipelineTag: w.pipeline_tag ?? null,
		tags: w.tags ?? [],
		gated: w.gated ?? false,
		lastModified: w.last_modified ?? null,
		createdAt: w.created_at ?? null,
		contextLength: w.context_length ?? null,
		architecture: w.architecture ?? null,
		params: w.params ?? null,
		installed: w.installed ?? false,
		format: w.format ?? "gguf",
		compatible: w.compatible ?? true,
		needsEngine: w.needs_engine ?? null,
	};
}

function toFile(w: FileWire): ModelFile {
	return {
		filename: w.filename,
		quant: w.quant ?? null,
		sizeBytes: w.size_bytes ?? null,
		sizeHuman: w.size_human ?? "",
		sha256: w.sha256 ?? null,
		url: w.url,
		installed: w.installed ?? false,
		fit: w.fit ?? "unknown",
		fitLabel: w.fit_label ?? "",
	};
}

function toStats(w: StatsWire | null | undefined): AaStats | null {
	if (!w) {
		return null;
	}
	return {
		matchedName: w.matched_name ?? "",
		intelligenceIndex: w.intelligence_index ?? null,
		outputTokensPerSecond: w.output_tokens_per_second ?? null,
		timeToFirstTokenS: w.time_to_first_token_s ?? null,
		priceUsdPer1m: w.price_usd_per_1m ?? null,
	};
}

function toDevice(w: DeviceWire | null | undefined): DeviceInfo {
	return {
		totalRamBytes: w?.total_ram_bytes ?? null,
		ramHuman: w?.ram_human ?? "",
		vramBytes: w?.vram_bytes ?? null,
		vramHuman: w?.vram_human ?? "",
		gpuName: w?.gpu_name ?? null,
		unifiedMemory: w?.unified_memory ?? false,
		os: w?.os ?? "",
	};
}

export interface SearchParams {
	/** Opaque pagination cursor from a prior page's {@link ModelPage.nextCursor}. */
	cursor?: string;
	/** Weight format facet (one clean cursor per format). Defaults to GGUF. */
	format?: ModelFormat;
	installedOnly?: boolean;
	limit?: number;
	/** Hugging Face org/user to restrict to (the "browse this org" filter). */
	org?: string;
	query?: string;
	sort?: ModelSort;
	/** Hugging Face `pipeline_tag` to narrow results to one task. Empty = any. */
	task?: string;
}

/** One page of catalog results plus the cursor for the next page (if any). */
export interface ModelPage {
	models: ModelCard[];
	nextCursor: string | null;
}

/**
 * Search the catalog. Core does the filtering/sorting/installed lookup and
 * returns an opaque `next_cursor` (Hugging Face cursor pagination) for infinite
 * scroll. The cursor is treated as opaque: `URLSearchParams` re-encodes it so it
 * survives the round-trip back to Core, which forwards it to the Hub verbatim.
 */
export async function searchModels(
	target: ApiTarget,
	params: SearchParams = {}
): Promise<ModelPage> {
	const q = new URLSearchParams();
	if (params.query) {
		q.set("query", params.query);
	}
	if (params.sort) {
		q.set("sort", params.sort);
	}
	if (params.limit) {
		q.set("limit", String(params.limit));
	}
	if (params.format) {
		q.set("format", params.format);
	}
	if (params.installedOnly) {
		q.set("installed_only", "true");
	}
	if (params.task) {
		q.set("task", params.task);
	}
	if (params.org) {
		q.set("author", params.org);
	}
	if (params.cursor) {
		q.set("cursor", params.cursor);
	}
	const json = await request<{
		models?: CardWire[];
		next_cursor?: string | null;
	}>(target, `/api/models/catalog?${q.toString()}`);
	return {
		models: (json.models ?? []).map(toCard),
		nextCursor: json.next_cursor ?? null,
	};
}

/** Fetch a model's full detail (README, files, device-fit, stats). */
export async function fetchModelDetail(
	target: ApiTarget,
	id: string,
	format: ModelFormat = "gguf"
): Promise<ModelDetail> {
	const json = await request<{
		card: CardWire;
		readme?: string | null;
		format?: ModelFormat;
		files?: FileWire[];
		vision?: boolean;
		stats?: StatsWire | null;
		stats_api_key_present?: boolean;
		device?: DeviceWire;
		repo_size_bytes?: number | null;
		repo_fit?: string;
		repo_fit_label?: string;
	}>(
		target,
		`/api/models/catalog/detail?id=${encodeURIComponent(id)}&format=${format}`
	);
	return {
		card: toCard(json.card),
		readme: json.readme ?? null,
		format: json.format ?? format,
		files: (json.files ?? []).map(toFile),
		vision: json.vision ?? false,
		stats: toStats(json.stats),
		statsApiKeyPresent: json.stats_api_key_present ?? false,
		device: toDevice(json.device),
		repoSizeBytes: json.repo_size_bytes ?? null,
		repoFit: json.repo_fit ?? "",
		repoFitLabel: json.repo_fit_label ?? "",
	};
}

export interface InstallResult {
	filename: string;
	path: string;
	repoId: string;
}

/** On-demand llmfit hardware fit + tok/s estimate for one model. `installed`
 *  gates the feature; `matched` says llmfit's catalog recognised the model. */
export interface LlmFitEstimate {
	fit_level: string | null;
	installed: boolean;
	matched: boolean;
	min_vram_gb: number | null;
	model_name: string | null;
	path: string | null;
	tps: number | null;
}

/**
 * Ask Core for an llmfit estimate for `repo`. Slow (~15s, networked) and only
 * matches llmfit's curated catalog, so call this ONLY on an explicit user action
 * (the "Estimate speed" button), never while listing models.
 */
export function estimateLlmfit(
	target: ApiTarget,
	repo: string,
	opts?: { context?: number; quant?: string }
): Promise<LlmFitEstimate> {
	const q = new URLSearchParams({ repo });
	if (opts?.context) {
		q.set("context", String(opts.context));
	}
	if (opts?.quant) {
		q.set("quant", opts.quant);
	}
	return request<LlmFitEstimate>(
		target,
		`/api/models/llmfit-estimate?${q.toString()}`
	);
}

/** Download + install a specific GGUF file via Core's verified downloader. */
export async function installModelFile(
	target: ApiTarget,
	id: string,
	file: string
): Promise<InstallResult> {
	track({ event: "model_install_started", model_id: id });
	let json: {
		success?: boolean;
		error?: string;
		result?: { repo_id: string; filename: string; path: string };
	};
	try {
		json = await request<{
			success?: boolean;
			error?: string;
			result?: { repo_id: string; filename: string; path: string };
		}>(target, "/api/models/catalog/install", {
			method: "POST",
			body: { id, file, format: "gguf" },
			// Forward the buyer's control-plane session so a PAID marketplace item's
			// entitlement check (#491) can resolve the org + license. Free items ignore it.
			headers: buyerTokenHeader(),
		});
	} catch (err) {
		track({ event: "model_install_completed", model_id: id, ok: false });
		throw err;
	}
	if (json.success === false || !json.result) {
		track({ event: "model_install_completed", model_id: id, ok: false });
		throw new Error(json.error ?? `Failed to install ${file}`);
	}
	track({ event: "model_install_completed", model_id: id, ok: true });
	return {
		repoId: json.result.repo_id,
		filename: json.result.filename,
		path: json.result.path,
	};
}

/**
 * Install a multi-file repo snapshot (safetensors / MLX). Core fetches the whole
 * repo into `~/.ryu/models/<slug>/` — there is no per-quant file to pick, so this
 * takes the repo id + format only.
 */
export async function installModelSnapshot(
	target: ApiTarget,
	id: string,
	format: ModelFormat
): Promise<InstallResult> {
	const json = await request<{
		success?: boolean;
		error?: string;
		result?: { repo_id: string; filename: string; path: string };
	}>(target, "/api/models/catalog/install", {
		method: "POST",
		body: { id, format },
		headers: buyerTokenHeader(),
	});
	if (json.success === false || !json.result) {
		throw new Error(json.error ?? `Failed to install ${id}`);
	}
	return {
		repoId: json.result.repo_id,
		filename: json.result.filename,
		path: json.result.path,
	};
}

/**
 * Remove a downloaded GGUF file. Core deletes the weight and clears its catalog
 * provenance, so the file flips back to "not installed" on the next fetch. `id`
 * is the model's repo id (used by Core only to scope cache invalidation).
 */
export async function uninstallModelFile(
	target: ApiTarget,
	id: string,
	file: string
): Promise<void> {
	const json = await request<{ success?: boolean; error?: string }>(
		target,
		"/api/models/catalog/uninstall",
		{
			method: "POST",
			body: { id, file },
		}
	);
	if (json.success === false) {
		throw new Error(json.error ?? `Failed to uninstall ${file}`);
	}
}

// ── Active served model (switch which installed GGUF the engine loads) ───────

/** The model the local chat stack is serving, plus the registry fallback. */
export interface ActiveModel {
	/** Effective served model ref (stem for GGUF, repo id for a snapshot). */
	active: string;
	/** Registry default served when no override is set. */
	default: string;
	/** The engine derived to serve the selection (e.g. "llamacpp", "vllm"). */
	engine: string | null;
	/** Weight format of the active selection. */
	format: ModelFormat;
	/** The selection ref (stem or repo id), or null when none is set. */
	ref: string | null;
	/** Hugging Face repo the selection was installed from, when known. */
	repoId: string | null;
}

/** Read which installed model the local chat engine is currently serving. */
export async function getActiveModel(target: ApiTarget): Promise<ActiveModel> {
	const json = await request<{
		active?: string;
		engine?: string | null;
		format?: ModelFormat;
		ref?: string | null;
		repo_id?: string | null;
		default?: string;
	}>(target, "/api/models/active");
	return {
		active: json.active ?? "",
		engine: json.engine ?? null,
		format: json.format ?? "gguf",
		ref: json.ref ?? null,
		repoId: json.repo_id ?? null,
		default: json.default ?? "",
	};
}

// ── Installed models (flat, by local stem) ──────────────────────────────────

/**
 * One model present on disk, keyed by its local `stem` (the servable ref). This
 * is the flat per-stem view (unlike the repo-keyed `/api/models/catalog`): it
 * surfaces fine-tuned GGUFs individually, which otherwise collapse under their
 * base repo card. `finetuneBase` is set only for merged fine-tunes.
 */
export interface InstalledModelEntry {
	filename: string;
	/** When this model is a merged fine-tune, the base it was trained from. */
	finetuneBase: string | null;
	format: ModelFormat;
	repoId: string;
	sizeBytes: number | null;
	stem: string;
}

/** List every installed model by stem. Returns `[]` on any error (e.g. an older
 * Core without the endpoint), so callers can render an empty state safely. */
export async function listInstalledModels(
	target: ApiTarget
): Promise<InstalledModelEntry[]> {
	try {
		const json = await request<{
			models?: {
				repo_id?: string;
				filename?: string;
				stem?: string;
				size_bytes?: number | null;
				format?: ModelFormat;
				finetune_base?: string | null;
			}[];
		}>(target, "/api/models/installed");
		return (json.models ?? []).map((m) => ({
			repoId: m.repo_id ?? "",
			filename: m.filename ?? "",
			stem: m.stem ?? "",
			sizeBytes: m.size_bytes ?? null,
			format: m.format ?? "gguf",
			finetuneBase: m.finetune_base ?? null,
		}));
	} catch {
		return [];
	}
}

/** One installed GGUF model whose file differs in size from the Hub's current
 *  upload — i.e. a newer quant is available. From `GET /api/models/updates`. */
export interface ModelUpdateEntry {
	filename: string;
	installedSize: number | null;
	latestSize: number | null;
	name: string;
	repoId: string;
	stem: string;
}

/** List installed models with a newer file upstream. Returns `[]` on any error
 *  (older Core without the endpoint), so the caller renders nothing. */
export async function listModelUpdates(
	target: ApiTarget
): Promise<ModelUpdateEntry[]> {
	try {
		const json = await request<{
			updates?: {
				stem?: string;
				repo_id?: string;
				filename?: string;
				name?: string;
				installed_size?: number | null;
				latest_size?: number | null;
			}[];
		}>(target, "/api/models/updates");
		return (json.updates ?? []).map((u) => ({
			stem: u.stem ?? "",
			repoId: u.repo_id ?? "",
			filename: u.filename ?? "",
			name: u.name ?? u.repo_id ?? "",
			installedSize: u.installed_size ?? null,
			latestSize: u.latest_size ?? null,
		}));
	} catch {
		return [];
	}
}

export interface SetActiveModelResult {
	active: string;
	engine: string | null;
	format: ModelFormat;
	gatewayRefreshed: boolean;
	restarted: boolean;
	swapped: boolean;
}

/**
 * Switch the model the local chat stack serves to an already-installed model.
 * `id` is either the local stem or the Hugging Face repo id (the deep-link
 * form). Core derives the engine from the model's format, makes it resident, and
 * refreshes the gateway; switching to an uninstalled model is rejected, as is a
 * model whose engine isn't runnable on this node. Pass `engine` to override the
 * derived engine (e.g. choose Ollama over llama.cpp for a GGUF model).
 */
export async function setActiveModel(
	target: ApiTarget,
	id: string,
	engine?: string
): Promise<SetActiveModelResult> {
	const json = await request<{
		success?: boolean;
		error?: string;
		active?: string;
		engine?: string | null;
		format?: ModelFormat;
		swapped?: boolean;
		restarted?: boolean;
		gateway_refreshed?: boolean;
	}>(target, "/api/models/active", {
		method: "POST",
		body: engine ? { id, engine } : { id },
	});
	if (json.success === false) {
		throw new Error(json.error ?? `Failed to switch to "${id}"`);
	}
	return {
		active: json.active ?? id,
		engine: json.engine ?? null,
		format: json.format ?? "gguf",
		swapped: json.swapped ?? false,
		restarted: json.restarted ?? false,
		gatewayRefreshed: json.gateway_refreshed ?? false,
	};
}

// ── Node engine capabilities (format → engine support) ──────────────────────

/** One engine and whether it's runnable on this node. */
export interface NodeEngine {
	name: string;
	supported: boolean;
}

/** Per-format engine support on this node. */
export interface NodeFormatSupport {
	engines: NodeEngine[];
	format: ModelFormat;
	supported: boolean;
}

/** The format → engine capability map for a node, plus the resident engine. */
export interface NodeEngines {
	formats: NodeFormatSupport[];
	resident: string | null;
}

/**
 * Read which weight formats (and engines) this node can run, computed on the
 * Core node so the verdict is authoritative even when the node is remote. Drives
 * the format facet + compatibility annotations in the Models tab.
 */
export async function getNodeEngines(target: ApiTarget): Promise<NodeEngines> {
	const json = await request<{
		formats?: {
			format: ModelFormat;
			supported?: boolean;
			engines?: { name: string; supported?: boolean }[];
		}[];
		resident?: string | null;
	}>(target, "/api/models/engines");
	return {
		formats: (json.formats ?? []).map((f) => ({
			format: f.format,
			supported: f.supported ?? false,
			engines: (f.engines ?? []).map((e) => ({
				name: e.name,
				supported: e.supported ?? false,
			})),
		})),
		resident: json.resident ?? null,
	};
}

// ── Catalog sources (#460) ──────────────────────────────────────────────────
//
// The Models catalog can be backed by more than one source (Hugging Face by
// default, ModelScope or a custom HF-compatible mirror). The active source lives
// in Core; the dropdown lists them and selects one, after which the model
// catalog re-keys against the newly-active endpoint.

/** One selectable catalog source. Mirrors Core's source descriptor. */
export interface CatalogSource {
	baseUrl: string | null;
	builtin: boolean;
	displayName: string;
	id: string;
}

interface SourceWire {
	base_url?: string | null;
	builtin?: boolean;
	display_name: string;
	id: string;
}

/** The active source id plus every source available for the model kind. */
export interface CatalogSources {
	active: string;
	sources: CatalogSource[];
}

function toSource(w: SourceWire): CatalogSource {
	return {
		id: w.id,
		displayName: w.display_name,
		builtin: w.builtin ?? false,
		baseUrl: w.base_url ?? null,
	};
}

/** List the model catalog sources and which one is active. */
export async function fetchModelSources(
	target: ApiTarget
): Promise<CatalogSources> {
	const json = await request<{
		active?: string;
		sources?: SourceWire[];
	}>(target, "/api/catalog/sources?kind=model");
	return {
		active: json.active ?? "",
		sources: (json.sources ?? []).map(toSource),
	};
}

/** Select the active model catalog source by id. */
export async function selectModelSource(
	target: ApiTarget,
	id: string
): Promise<void> {
	await request<unknown>(target, "/api/catalog/sources/select", {
		method: "POST",
		body: { kind: "model", id },
	});
}
