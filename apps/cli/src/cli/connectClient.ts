// A typed client for Ryu Connect's REST API and the anonymous tool catalog
// browse API (Treg parity B12). The `ryu connect` command is a thin layer over
// it; tests drive it against a loopback stand-in.
//
// Every answer is parsed with a schema before it is used, so a changed or
// hostile server can only produce a ConnectError, never an undefined field.
// The Connect key is sent only to the configured Connect origin: HTTPS, or
// plain HTTP to loopback; redirects are never followed, so the key can never
// be carried to another host.

import { z } from "zod";

export type FetchLike = (
	input: string | URL,
	init?: RequestInit
) => Promise<Response>;

/** Answers larger than this are refused; Connect caps tool answers well below it. */
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A refused or failed request, carrying Connect's `code` and fields. */
export class ConnectError extends Error {
	readonly body: Record<string, unknown>;
	readonly code: string;
	readonly retryAfterSeconds: number | null;
	readonly status: number;

	constructor(
		status: number,
		code: string,
		message: string,
		body: Record<string, unknown> = {},
		retryAfterSeconds: number | null = null
	) {
		super(message);
		this.status = status;
		this.code = code;
		this.body = body;
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

/** HTTPS, or HTTP to loopback, with no credentials, query or fragment. */
export function parseServiceUrl(value: string, name: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${name} must be an absolute URL`);
	}
	if (
		!(
			url.protocol === "https:" ||
			(url.protocol === "http:" && LOOPBACK.has(url.hostname))
		) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error(
			`${name} must use HTTPS (or HTTP to localhost) without credentials, a query or a fragment`
		);
	}
	return url;
}

const priceSchema = z.object({
	amountMicroUsd: z.number(),
	estimated: z.boolean(),
	per: z.literal("call"),
	source: z.string(),
});

const catalogSchema = z
	.object({
		source: z.string().optional(),
		state: z.string().optional(),
	})
	.loose();

const reliabilitySchema = z
	.object({
		sufficient: z.boolean().optional(),
		successRate: z.number().nullable().optional(),
		p50Ms: z.number().nullable().optional(),
		p95Ms: z.number().nullable().optional(),
	})
	.loose();

export const toolDescriptorSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		description: z.string(),
		kind: z.string(),
		provider: z.string(),
		tier: z.string(),
		toolkit: z.string().optional(),
		price: priceSchema,
		score: z.number().optional(),
		catalog: catalogSchema.optional(),
		reliability: reliabilitySchema.optional(),
		lifecycle: z.string().optional(),
	})
	.loose();
export type ToolDescriptor = z.infer<typeof toolDescriptorSchema>;

export const searchResultSchema = z.object({
	object: z.literal("list"),
	data: z.array(toolDescriptorSchema),
	didYouMean: z.array(z.string()).optional(),
	missedTerms: z.array(z.string()).optional(),
	partial: z.literal(true).optional(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const describedToolSchema = toolDescriptorSchema.extend({
	parameters: z.unknown(),
});
export type DescribedTool = z.infer<typeof describedToolSchema>;

export const balanceSchema = z.object({
	object: z.literal("balance"),
	availableMicroUsd: z.number().nullable(),
	billed: z.boolean(),
	heldMicroUsd: z.number(),
	headroomMicroUsd: z.number().nullable(),
	suspended: z.boolean(),
	topUpUrl: z.string().nullable(),
	unsettledMicroUsd: z.number().nullable(),
	unsettledSince: z.string().nullable(),
});
export type Balance = z.infer<typeof balanceSchema>;

export const toolRequestReceiptSchema = z
	.object({
		ok: z.literal(true),
		status: z.string(),
		id: z.string().optional(),
	})
	.loose();
export type ToolRequestReceipt = z.infer<typeof toolRequestReceiptSchema>;

/** The money fields every Connect call answer carries. */
export const callMoneySchema = z.object({
	ryuCallId: z.string(),
	costMicroUsd: z.number(),
	chargedMicroUsd: z.number().nullable(),
	estimated: z.boolean(),
	exceededMaxCost: z.boolean(),
	ledgerRefId: z.string().nullable(),
	priceSource: z.string().nullable(),
});

export const callAnswerSchema = callMoneySchema
	.extend({
		ok: z.boolean(),
		result: z
			.object({
				content: z.array(z.unknown()).optional(),
				isError: z.boolean().optional(),
				structuredContent: z.unknown().optional(),
			})
			.loose(),
	})
	.loose();
export type CallAnswer = z.infer<typeof callAnswerSchema>;

export const healthSchema = z
	.object({
		service: z.string(),
		version: z.string().optional(),
		apiVersion: z.string().optional(),
	})
	.loose();
export type Health = z.infer<typeof healthSchema>;

const costSchema = z
	.object({
		basis: z.string(),
		usd: z.number().nullable(),
		value: z.number().nullable(),
		currency: z.string(),
		free: z.boolean(),
	})
	.loose();
const browseEndpointSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		provider: z.string(),
		provider_display: z.string(),
		source: z.string(),
		cost: costSchema.nullable(),
		verification: z.object({ state: z.string() }).loose(),
		platform_eligible: z.boolean(),
	})
	.loose();
const browseSummarySchema = z
	.object({
		slug: z.string(),
		label: z.string(),
		endpoints: z.number(),
		verified_endpoints: z.number(),
		capabilities: z.number(),
		providers: z.array(z.string()),
		price_from: costSchema.nullable(),
		source: z.string(),
	})
	.loose();
export const platformIndexSchema = z
	.object({
		type: z.literal("ryu.tool_catalog.platforms"),
		generated_at: z.string(),
		platforms: z.array(browseSummarySchema),
	})
	.loose();
export const platformDetailSchema = browseSummarySchema
	.extend({
		type: z.literal("ryu.tool_catalog.platform"),
		domains: z.array(
			z
				.object({
					id: z.string(),
					label: z.string(),
					rows: z.array(
						z
							.object({
								capability: z.string(),
								capability_name: z.string(),
								cheapest_endpoint: z.string().nullable(),
								endpoints: z.array(browseEndpointSchema),
							})
							.loose()
					),
				})
				.loose()
		),
	})
	.loose();

/** The subset of `@ryuhq/protocol/tool-catalog-browse`'s shapes the CLI reads. */
export type PlatformIndex = z.infer<typeof platformIndexSchema>;
export type PlatformDetail = z.infer<typeof platformDetailSchema>;

const refusalSchema = z
	.object({
		code: z.string().optional(),
		error: z.string().optional(),
	})
	.loose();

interface ClientOptions {
	fetch?: FetchLike;
	timeoutMs?: number;
	userAgent?: string;
}

async function readBounded(response: Response): Promise<string> {
	const declared = Number(response.headers.get("content-length") ?? "0");
	if (Number.isFinite(declared) && declared > MAX_ANSWER_BYTES) {
		await response.body?.cancel();
		throw new ConnectError(
			response.status,
			"answer_too_large",
			"The answer is too large"
		);
	}
	const reader = response.body?.getReader();
	if (!reader) {
		return "";
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		size += value.byteLength;
		if (size > MAX_ANSWER_BYTES) {
			await reader.cancel();
			throw new ConnectError(
				response.status,
				"answer_too_large",
				"The answer is too large"
			);
		}
		chunks.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

function retryAfter(response: Response): number | null {
	const value = response.headers.get("retry-after")?.trim();
	return value && /^\d{1,9}$/u.test(value) ? Number(value) : null;
}

/** One JSON request; a non-2xx answer becomes a ConnectError with Connect's code. */
async function requestJson<T>(
	fetchImpl: FetchLike,
	url: URL,
	schema: z.ZodType<T>,
	init: RequestInit,
	timeoutMs: number
): Promise<T> {
	let response: Response;
	try {
		response = await fetchImpl(url, {
			...init,
			redirect: "manual",
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		const reason =
			error instanceof Error && error.name === "TimeoutError"
				? "timed out"
				: "is unreachable";
		throw new ConnectError(0, "unreachable", `${url.origin} ${reason}`);
	}
	if (response.status >= 300 && response.status < 400) {
		await response.body?.cancel();
		throw new ConnectError(
			response.status,
			"redirect_refused",
			"The server redirected the request; it was not followed"
		);
	}
	const text = await readBounded(response);
	let decoded: unknown;
	try {
		decoded = text === "" ? {} : JSON.parse(text);
	} catch {
		throw new ConnectError(
			response.status,
			"invalid_answer",
			`The server answered HTTP ${response.status} without JSON`
		);
	}
	if (!response.ok) {
		const refusal = refusalSchema.safeParse(decoded);
		const body = refusal.success ? refusal.data : {};
		const code = body.code ?? `http_${response.status}`;
		throw new ConnectError(
			response.status,
			code,
			body.error ?? `${code} (HTTP ${response.status})`,
			body,
			retryAfter(response)
		);
	}
	const parsed = schema.safeParse(decoded);
	if (!parsed.success) {
		throw new ConnectError(
			response.status,
			"invalid_answer",
			"The server's answer does not match the Connect API"
		);
	}
	return parsed.data;
}

export interface CallOptions {
	/** `Idempotency-Key`: reuse it only to retry the same call. */
	idempotencyKey?: string;
	/** `x-ryu-max-cost-micro-usd`: refuse the call when its estimate is higher. */
	maxCostMicroUsd?: number;
}

/** Ryu Connect's REST API with one Connect key. */
export class ConnectClient {
	readonly #base: URL;
	readonly #fetch: FetchLike;
	readonly #key: string | undefined;
	readonly #timeoutMs: number;
	readonly #userAgent: string;

	constructor(
		baseUrl: string,
		key: string | undefined,
		options: ClientOptions = {}
	) {
		this.#base = parseServiceUrl(baseUrl, "The Connect URL");
		this.#key = key?.trim() || undefined;
		this.#fetch = options.fetch ?? fetch;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#userAgent = options.userAgent ?? "ryu-cli";
	}

	get origin(): string {
		return this.#base.origin;
	}

	get hasKey(): boolean {
		return this.#key !== undefined;
	}

	#url(path: string, query: Record<string, string | undefined> = {}): URL {
		const prefix = this.#base.pathname.replace(/\/+$/u, "");
		const url = new URL(`${prefix}${path}`, this.#base.origin);
		for (const [name, value] of Object.entries(query)) {
			if (value !== undefined) {
				url.searchParams.set(name, value);
			}
		}
		return url;
	}

	#headers(extra: Record<string, string> = {}): Record<string, string> {
		if (!this.#key) {
			throw new ConnectError(
				401,
				"key_missing",
				"Set RYU_CONNECT_KEY to your Connect key"
			);
		}
		return {
			accept: "application/json",
			authorization: `Bearer ${this.#key}`,
			"user-agent": this.#userAgent,
			...extra,
		};
	}

	/** `GET /health`: needs no key. */
	health(): Promise<Health> {
		return requestJson(
			this.#fetch,
			this.#url("/health"),
			healthSchema,
			{
				headers: { accept: "application/json", "user-agent": this.#userAgent },
			},
			this.#timeoutMs
		);
	}

	balance(): Promise<Balance> {
		return requestJson(
			this.#fetch,
			this.#url("/v1/balance"),
			balanceSchema,
			{ headers: this.#headers() },
			this.#timeoutMs
		);
	}

	search(
		query: string,
		options: { kind?: "any" | "composio" | "mcp"; limit?: number } = {}
	): Promise<SearchResult> {
		return requestJson(
			this.#fetch,
			this.#url("/v1/tools/search", {
				q: query,
				limit: options.limit === undefined ? undefined : String(options.limit),
				kind: options.kind,
			}),
			searchResultSchema,
			{ headers: this.#headers() },
			this.#timeoutMs
		);
	}

	describe(id: string): Promise<DescribedTool> {
		return requestJson(
			this.#fetch,
			this.#url("/v1/tools/describe", { id }),
			describedToolSchema,
			{ headers: this.#headers() },
			this.#timeoutMs
		);
	}

	requestTool(input: {
		description: string;
		query?: string;
		toolkit?: string;
	}): Promise<ToolRequestReceipt> {
		return requestJson(
			this.#fetch,
			this.#url("/v1/tools/requests"),
			toolRequestReceiptSchema,
			{
				method: "POST",
				headers: this.#headers({ "content-type": "application/json" }),
				body: JSON.stringify(input),
			},
			this.#timeoutMs
		);
	}

	call(
		toolId: string,
		args: Record<string, unknown>,
		options: CallOptions = {}
	): Promise<CallAnswer> {
		const extra: Record<string, string> = {
			"content-type": "application/json",
		};
		if (options.idempotencyKey !== undefined) {
			extra["idempotency-key"] = options.idempotencyKey;
		}
		if (options.maxCostMicroUsd !== undefined) {
			extra["x-ryu-max-cost-micro-usd"] = String(options.maxCostMicroUsd);
		}
		return requestJson(
			this.#fetch,
			this.#url("/v1/exec/tool"),
			callAnswerSchema,
			{
				method: "POST",
				headers: this.#headers(extra),
				body: JSON.stringify({ tool_id: toolId, arguments: args }),
			},
			this.#timeoutMs
		);
	}
}

/** Ryu's anonymous tool catalog browse API (`/api/tool-catalog/catalog/*`). */
export class CatalogClient {
	readonly #base: URL;
	readonly #fetch: FetchLike;
	readonly #timeoutMs: number;

	constructor(baseUrl: string, options: ClientOptions = {}) {
		this.#base = parseServiceUrl(baseUrl, "The catalog URL");
		this.#fetch = options.fetch ?? fetch;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	#url(path: string): URL {
		const prefix = this.#base.pathname.replace(/\/+$/u, "");
		return new URL(`${prefix}${path}`, this.#base.origin);
	}

	platforms(): Promise<PlatformIndex> {
		return requestJson(
			this.#fetch,
			this.#url("/catalog/platforms"),
			platformIndexSchema,
			{ headers: { accept: "application/json" } },
			this.#timeoutMs
		);
	}

	platform(slug: string): Promise<PlatformDetail> {
		if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/u.test(slug)) {
			return Promise.reject(
				new ConnectError(400, "invalid_platform", `Invalid platform: ${slug}`)
			);
		}
		return requestJson(
			this.#fetch,
			this.#url(`/catalog/platforms/${encodeURIComponent(slug)}`),
			platformDetailSchema,
			{ headers: { accept: "application/json" } },
			this.#timeoutMs
		);
	}
}

/** Micro-USD as dollars, e.g. 400 → `$0.0004`; null is `-`. */
export function formatMicroUsd(value: number | null | undefined): string {
	if (value === null || value === undefined) {
		return "-";
	}
	const dollars = value / 1_000_000;
	const text = dollars.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "");
	return `$${text === "" ? "0" : text}`;
}
