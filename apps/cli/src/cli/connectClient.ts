// A typed client for Ryu Connect's REST API and the anonymous tool catalog
// browse API (Treg parity B12). The `ryu-cli connect` command is a thin layer
// over it; tests drive it against a loopback stand-in.
//
// Every answer is parsed with a schema before it is used, so a changed or
// hostile server can only produce a ConnectError, never an undefined field.
// The Connect key is sent only to the configured Connect origin: HTTPS, or
// plain HTTP to loopback; redirects are never followed, so the key can never
// be carried to another host. Schemas live in `connectClient-schemas.ts` and
// the request plumbing in `connectClient-request.ts`.

import {
	type ClientOptions,
	ConnectError,
	type FetchLike,
	parseServiceUrl,
	requestJson,
} from "./connectClient-request.ts";
import {
	type Balance,
	balanceSchema,
	type CallAnswer,
	callAnswerSchema,
	type DescribedTool,
	describedToolSchema,
	type Health,
	healthSchema,
	type PlatformDetail,
	type PlatformIndex,
	platformDetailSchema,
	platformIndexSchema,
	type SearchResult,
	searchResultSchema,
	type ToolRequestReceipt,
	toolRequestReceiptSchema,
} from "./connectClient-schemas.ts";
import { localize } from "./localizedText.ts";

export {
	ConnectError,
	type FetchLike,
	parseServiceUrl,
	type ServiceUrlKind,
} from "./connectClient-request.ts";
export {
	type Balance,
	balanceSchema,
	type CallAnswer,
	callAnswerSchema,
	callMoneySchema,
	type DescribedTool,
	describedToolSchema,
	type Health,
	healthSchema,
	type PlatformDetail,
	type PlatformIndex,
	platformDetailSchema,
	platformIndexSchema,
	type SearchResult,
	searchResultSchema,
	type ToolDescriptor,
	type ToolRequestReceipt,
	toolDescriptorSchema,
	toolRequestReceiptSchema,
} from "./connectClient-schemas.ts";

const DEFAULT_TIMEOUT_MS = 60_000;

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
		this.#base = parseServiceUrl(baseUrl, "connect");
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
				localize("Set {variable} to your Connect key.", {
					variable: "RYU_CONNECT_KEY",
				})
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
		this.#base = parseServiceUrl(baseUrl, "catalog");
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
				new ConnectError(
					400,
					"invalid_platform",
					localize("Invalid platform: {slug}", { slug })
				)
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
