import { z } from "zod";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
// apps/desktop/src/lib/api/models.ts
//
// Typed client for Core's model-catalog endpoints (`/api/models/*`). The catalog
// lets a user browse Hugging Face GGUF models, read each model's card, see which
// quantizations fit their device, and install one. ALL logic (search, sort,
// device-fit, stats, install) lives in Core — this module only shapes requests
// and parses responses, so the same Core powers the desktop, mobile, and
// extension surfaces identically.

import {
	MODEL_CATEGORY_OPTIONS,
	type ModelCategory,
} from "@ryu/marketplace/catalog/types";
import {
	type ActiveModelPreview,
	activeModelPreviewSchema,
	type ModelInstallPreview,
	type ModelUninstallPreview,
	modelInstallPreviewSchema,
	modelUninstallPreviewSchema,
} from "@ryuhq/core-client/model-preview-contracts.ts";
import type {
	AaStats,
	ActiveModel,
	CatalogSource,
	CatalogSources,
	DeviceInfo,
	FitVerdict,
	InstallResult,
	ModelCard,
	ModelFormat,
	NodeEngines,
	SearchParams,
	SetActiveModelResult,
} from "@ryuhq/core-client/models.ts";
import { track } from "@/src/lib/analytics.ts";
import {
	ApiError,
	type ApiTarget,
	buyerTokenHeader,
	request,
} from "./client.ts";

export type {
	AaStats,
	ActiveModel,
	CatalogSource,
	CatalogSources,
	DeviceInfo,
	FitVerdict,
	InstallResult,
	ModelCard,
	ModelFormat,
	ModelSort,
	NodeEngine,
	NodeEngines,
	NodeFormatSupport,
	SearchParams,
	SetActiveModelResult,
} from "@ryuhq/core-client/models.ts";

const modelsResponseSchema = z.looseObject({
	architecture: z.union([z.null(), z.string()]).optional(),
	author: z.string(),
	compatible: z.boolean().optional(),
	context_length: z.union([z.null(), z.number()]).optional(),
	created_at: z.union([z.null(), z.string()]).optional(),
	downloads: z.number().optional(),
	format: z
		.union([z.literal("gguf"), z.literal("safetensors"), z.literal("mlx")])
		.optional(),
	gated: z.boolean().optional(),
	id: z.string(),
	installed: z.boolean().optional(),
	last_modified: z.union([z.null(), z.string()]).optional(),
	likes: z.number().optional(),
	name: z.string(),
	needs_engine: z.union([z.null(), z.string()]).optional(),
	params: z.union([z.null(), z.number()]).optional(),
	pipeline_tag: z.union([z.null(), z.string()]).optional(),
	tags: z.array(z.string()).optional(),
});
const jsonResponseSchema = z.looseObject({
	models: z.array(modelsResponseSchema).optional(),
	next_cursor: z.union([z.null(), z.string()]).optional(),
	total: z.union([z.null(), z.number()]).optional(),
	total_count: z.union([z.null(), z.number()]).optional(),
});
const filesResponseSchema = z.looseObject({
	filename: z.string(),
	fit: z
		.union([
			z.literal("no_space"),
			z.literal("too_big"),
			z.literal("cpu"),
			z.literal("partial"),
			z.literal("ok"),
			z.literal("great"),
			z.literal("unknown"),
		])
		.optional(),
	fit_label: z.string().optional(),
	installed: z.boolean().optional(),
	quant: z.union([z.null(), z.string()]).optional(),
	sha256: z.union([z.null(), z.string()]).optional(),
	size_bytes: z.union([z.null(), z.number()]).optional(),
	size_human: z.string().optional(),
	url: z.string(),
});
const statsResponseSchema = z.looseObject({
	intelligence_index: z.union([z.null(), z.number()]).optional(),
	matched_name: z.string().optional(),
	output_tokens_per_second: z.union([z.null(), z.number()]).optional(),
	price_usd_per_1m: z.union([z.null(), z.number()]).optional(),
	time_to_first_token_s: z.union([z.null(), z.number()]).optional(),
});
const deviceResponseSchema = z.looseObject({
	disk_free_bytes: z.union([z.null(), z.number()]).optional(),
	disk_free_human: z.string().optional(),
	gpu_name: z.union([z.null(), z.string()]).optional(),
	os: z.string().optional(),
	ram_human: z.string().optional(),
	total_ram_bytes: z.union([z.null(), z.number()]).optional(),
	unified_memory: z.boolean().optional(),
	vram_bytes: z.union([z.null(), z.number()]).optional(),
	vram_human: z.string().optional(),
});
const jsonResponseSchema2 = z.looseObject({
	card: modelsResponseSchema,
	readme: z.union([z.null(), z.string()]).optional(),
	format: z
		.union([z.literal("gguf"), z.literal("safetensors"), z.literal("mlx")])
		.optional(),
	files: z.array(filesResponseSchema).optional(),
	vision: z.boolean().optional(),
	stats: z.union([z.null(), statsResponseSchema]).optional(),
	stats_api_key_present: z.boolean().optional(),
	device: deviceResponseSchema.optional(),
	repo_size_bytes: z.union([z.null(), z.number()]).optional(),
	repo_fit: z.string().optional(),
	repo_fit_label: z.string().optional(),
});
const estimateLlmfitResponseSchema = z.looseObject({
	fit_level: z.union([z.null(), z.string()]),
	installed: z.boolean(),
	matched: z.boolean(),
	min_vram_gb: z.union([z.null(), z.number()]),
	model_name: z.union([z.null(), z.string()]),
	path: z.union([z.null(), z.string()]),
	tps: z.union([z.null(), z.number()]),
});
const resultResponseSchema = z.looseObject({
	repo_id: z.string(),
	filename: z.string(),
	path: z.string(),
});
const installModelFileResponseSchema = z.looseObject({
	success: z.boolean().optional(),
	error: z.string().optional(),
	result: resultResponseSchema.optional(),
});
const resultResponseSchema2 = z.looseObject({
	repo_id: z.string(),
	filename: z.string(),
	path: z.string(),
});
const jsonResponseSchema3 = z.looseObject({
	success: z.boolean().optional(),
	error: z.string().optional(),
	result: resultResponseSchema2.optional(),
});
const jsonResponseSchema4 = z.looseObject({
	success: z.boolean().optional(),
	error: z.string().optional(),
});
const jsonResponseSchema5 = z.looseObject({
	active: z.string().optional(),
	engine: z.union([z.null(), z.string()]).optional(),
	format: z
		.union([z.literal("gguf"), z.literal("safetensors"), z.literal("mlx")])
		.optional(),
	ref: z.union([z.null(), z.string()]).optional(),
	repo_id: z.union([z.null(), z.string()]).optional(),
	default: z.string().optional(),
});
const modelsResponseSchema2 = z.looseObject({
	repo_id: z.string().optional(),
	filename: z.string().optional(),
	stem: z.string().optional(),
	size_bytes: z.union([z.null(), z.number()]).optional(),
	format: z
		.union([z.literal("gguf"), z.literal("safetensors"), z.literal("mlx")])
		.optional(),
	finetune_base: z.union([z.null(), z.string()]).optional(),
});
const jsonResponseSchema6 = z.looseObject({
	models: z.array(modelsResponseSchema2).optional(),
});
const updatesResponseSchema = z.looseObject({
	stem: z.string().optional(),
	repo_id: z.string().optional(),
	filename: z.string().optional(),
	name: z.string().optional(),
	installed_size: z.union([z.null(), z.number()]).optional(),
	latest_size: z.union([z.null(), z.number()]).optional(),
});
const jsonResponseSchema7 = z.looseObject({
	updates: z.array(updatesResponseSchema).optional(),
});
const jsonResponseSchema8 = z.looseObject({
	success: z.boolean().optional(),
	error: z.string().optional(),
	active: z.string().optional(),
	engine: z.union([z.null(), z.string()]).optional(),
	format: z
		.union([z.literal("gguf"), z.literal("safetensors"), z.literal("mlx")])
		.optional(),
	swapped: z.boolean().optional(),
	restarted: z.boolean().optional(),
	gateway_refreshed: z.boolean().optional(),
});
const enginesResponseSchema = z.looseObject({
	name: z.string(),
	supported: z.boolean().optional(),
});
const formatsResponseSchema = z.looseObject({
	format: z.union([
		z.literal("gguf"),
		z.literal("safetensors"),
		z.literal("mlx"),
	]),
	supported: z.boolean().optional(),
	engines: z.array(enginesResponseSchema).optional(),
});
const jsonResponseSchema9 = z.looseObject({
	formats: z.array(formatsResponseSchema).optional(),
	resident: z.union([z.null(), z.string()]).optional(),
});
const sourcesResponseSchema = z.looseObject({
	base_url: z.union([z.null(), z.string()]).optional(),
	builtin: z.boolean().optional(),
	display_name: z.string(),
	id: z.string(),
});
const jsonResponseSchema10 = z.looseObject({
	active: z.string().optional(),
	sources: z.array(sourcesResponseSchema).optional(),
});

export type { ModelCategory } from "@ryu/marketplace/catalog/types";
export type {
	ActiveModelPreview,
	ModelInstallPreview,
	ModelUninstallPreview,
} from "@ryuhq/core-client/model-preview-contracts.ts";

/** Every catalog format the desktop fans out across. */
export const MODEL_FORMATS: ModelFormat[] = ["gguf", "safetensors", "mlx"];

/** Category → Hugging Face `pipeline_tag`. `"all"` means no filter. */
export const MODEL_CATEGORY_TASK: Record<ModelCategory, string> =
	/* SAFETY: The native MODEL_CATEGORY_OPTIONS table defines ModelCategory from its exact value union, with a string pipelineTag for every entry. Mapping every entry through Object.fromEntries covers that authored key domain; no catalog response is cast here. */ Object.fromEntries(
		MODEL_CATEGORY_OPTIONS.map(({ value, pipelineTag }) => [value, pipelineTag])
	) as Record<ModelCategory, string>;

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
	disk_free_bytes?: number | null;
	disk_free_human?: string;
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
		// Keep undefined (an older Core never sends it) apart from null (unknown).
		diskFreeBytes: w?.disk_free_bytes,
		diskFreeHuman: w?.disk_free_human ?? "",
		totalRamBytes: w?.total_ram_bytes ?? null,
		ramHuman: w?.ram_human ?? "",
		vramBytes: w?.vram_bytes ?? null,
		vramHuman: w?.vram_human ?? "",
		gpuName: w?.gpu_name ?? null,
		unifiedMemory: w?.unified_memory ?? false,
		os: w?.os ?? "",
	};
}

/** One page of catalog results plus the cursor for the next page (if any). */
export interface ModelPage {
	models: ModelCard[];
	nextCursor: string | null;
	total?: number | null;
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
	const json = await request(
		target,
		`/api/models/catalog?${q.toString()}`,
		undefined,
		jsonResponseSchema
	);
	return {
		models: (json.models ?? []).map(toCard),
		nextCursor: json.next_cursor ?? null,
		total: json.total ?? json.total_count ?? null,
	};
}

/** Fetch a model's full detail (README, files, device-fit, stats). */
export async function fetchModelDetail(
	target: ApiTarget,
	id: string,
	format: ModelFormat = "gguf"
): Promise<ModelDetail> {
	const json = await request(
		target,
		`/api/models/catalog/detail?id=${encodeURIComponent(id)}&format=${format}`,
		undefined,
		jsonResponseSchema2
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
	return request(
		target,
		`/api/models/llmfit-estimate?${q.toString()}`,
		undefined,
		estimateLlmfitResponseSchema
	);
}

/** Core's machine codes for an install it refuses before downloading anything. */
export type ModelInstallBlockCode = "model_too_large" | "insufficient_disk";

/**
 * Core refused an install (HTTP 422) because the model would not fit the
 * serving node's memory or free disk. `message` is Core's plain-language reason
 * with the real numbers, so callers can show it as-is.
 */
export class ModelInstallBlockedError extends Error {
	readonly code: ModelInstallBlockCode | null;

	constructor(message: string, code: ModelInstallBlockCode | null) {
		super(message);
		this.name = "ModelInstallBlockedError";
		this.code = code;
	}
}

const installBlockBodySchema = z.looseObject({
	code: z.string().optional().catch(undefined),
	message: z.string().optional().catch(undefined),
});

function installBlockCode(
	code: string | undefined
): ModelInstallBlockCode | null {
	return code === "model_too_large" || code === "insufficient_disk"
		? code
		: null;
}

/**
 * Map Core's install refusal (422 `model_too_large` / `insufficient_disk`) to a
 * {@link ModelInstallBlockedError} carrying the human message instead of the
 * generic "<path> failed: 422". The body may put the message in `error` (string
 * or `{ message, code }`) or at the top level; every other error passes through.
 */
export function toModelInstallError(err: unknown): unknown {
	if (!(err instanceof ApiError) || err.status !== 422) {
		return err;
	}
	const body = installBlockBodySchema.safeParse(err.body);
	const topLevel = body.success ? body.data : {};
	const message =
		err.serverMessage ??
		topLevel.message ??
		"This model won't fit on this device, so it wasn't added.";
	return new ModelInstallBlockedError(
		message,
		installBlockCode(err.code ?? topLevel.code)
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
		json = await request(
			target,
			"/api/models/catalog/install",
			{
				method: "POST",
				body: { id, file, format: "gguf" },
				// Forward the buyer's control-plane session for optional Marketplace
				// account-aware operations. It is not required for installation.
				headers: buyerTokenHeader(target),
			},
			installModelFileResponseSchema
		);
	} catch (err) {
		track({ event: "model_install_completed", model_id: id, ok: false });
		throw toModelInstallError(err);
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
 * repo into `~/.ryu/models/chat/snapshots/<slug>/` — there is no per-quant file to pick, so this
 * takes the repo id + format only.
 */
export async function installModelSnapshot(
	target: ApiTarget,
	id: string,
	format: ModelFormat
): Promise<InstallResult> {
	const json = await request(
		target,
		"/api/models/catalog/install",
		{
			method: "POST",
			body: { id, format },
			headers: buyerTokenHeader(target),
		},
		jsonResponseSchema3
	).catch((err: unknown) => {
		throw toModelInstallError(err);
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
	const json = await request(
		target,
		"/api/models/catalog/uninstall",
		{
			method: "POST",
			body: { id, file },
		},
		jsonResponseSchema4
	);
	if (json.success === false) {
		throw new Error(json.error ?? `Failed to uninstall ${file}`);
	}
}

/** Resolve model metadata and return the download plan without writing weights. */
export function previewModelInstall(
	target: ApiTarget,
	id: string,
	options: { file?: string; format?: ModelFormat } = {}
): Promise<ModelInstallPreview> {
	return request(
		target,
		"/api/models/catalog/install",
		{
			method: "POST",
			body: {
				dryRun: true,
				id,
				...(options.file ? { file: options.file } : undefined),
				...(options.format ? { format: options.format } : undefined),
			},
			headers: buyerTokenHeader(target),
		},
		gatewayJsonValueSchema
	).then((value) => modelInstallPreviewSchema.parse(value));
}

/** Validate and project model removal without deleting the weight or adapter. */
export function previewModelUninstall(
	target: ApiTarget,
	id: string,
	file: string
): Promise<ModelUninstallPreview> {
	return request(
		target,
		"/api/models/catalog/uninstall",
		{
			method: "POST",
			body: { dryRun: true, file, id },
		},
		gatewayJsonValueSchema
	).then((value) => modelUninstallPreviewSchema.parse(value));
}

// ── Active served model (switch which installed GGUF the engine loads) ───────

/** Read which installed model local Chat is currently serving. */
export async function getActiveModel(target: ApiTarget): Promise<ActiveModel> {
	const json = await request(
		target,
		"/api/models/active",
		undefined,
		jsonResponseSchema5
	);
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
		const json = await request(
			target,
			"/api/models/installed",
			undefined,
			jsonResponseSchema6
		);
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
		const json = await request(
			target,
			"/api/models/updates",
			undefined,
			jsonResponseSchema7
		);
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

/** Resolve an installed model and report the engine/gateway changes without switching it. */
export function previewActiveModel(
	target: ApiTarget,
	id: string,
	engine?: string
): Promise<ActiveModelPreview> {
	return request(
		target,
		"/api/models/active",
		{
			method: "POST",
			body: engine ? { dryRun: true, id, engine } : { dryRun: true, id },
		},
		gatewayJsonValueSchema
	).then((value) => activeModelPreviewSchema.parse(value));
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
	const json = await request(
		target,
		"/api/models/active",
		{
			method: "POST",
			body: engine ? { id, engine } : { id },
		},
		jsonResponseSchema8
	);
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

/**
 * Read which weight formats (and engines) this node can run, computed on the
 * Core node so the verdict is authoritative even when the node is remote. Drives
 * the format facet + compatibility annotations in the Models tab.
 */
export async function getNodeEngines(target: ApiTarget): Promise<NodeEngines> {
	const json = await request(
		target,
		"/api/models/engines",
		undefined,
		jsonResponseSchema9
	);
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

interface SourceWire {
	base_url?: string | null;
	builtin?: boolean;
	display_name: string;
	id: string;
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
	const json = await request(
		target,
		"/api/catalog/sources?kind=model",
		undefined,
		jsonResponseSchema10
	);
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
	await request(
		target,
		"/api/catalog/sources/select",
		{
			method: "POST",
			body: { kind: "model", id },
		},
		gatewayJsonValueSchema
	);
}
