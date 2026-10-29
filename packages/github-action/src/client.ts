import type { RunEvalsRequest } from "@ryuhq/core-client/gateway";
import { z } from "zod";
import {
	JsonRecordSchema,
	type JsonValue,
	JsonValueSchema,
	jsonRecord,
	nonemptyString,
} from "./json.ts";
import { parseCoreChatStream, type StreamCallbacks } from "./sse.ts";
import type {
	ChatRequest,
	ChatResult,
	NodeHealth,
	NodeInfo,
	NodeSnapshot,
	ResolvedTarget,
	TargetMode,
	ToolRequest,
	ToolResult,
} from "./types.ts";

export type FetchLike = (
	input: string | URL,
	init?: RequestInit
) => Promise<Response>;

/** Header carrying a machine vault token on `/api/vault/agent/*`. */
export const VAULT_TOKEN_HEADER = "x-ryu-vault-token";

/** How a request authenticates: the node bearer, nothing (public login), or a
 *  vault token (agent routes). */
type RequestAuth = "node" | "none" | { vaultToken: string };

export interface VaultLoginResult {
	accessor: string;
	expiresAt: string;
	identityId: string;
	token: string;
}

export class RyuHttpError extends Error {
	readonly path: string;
	readonly status: number;

	constructor(path: string, status: number, message: string) {
		super(`${path} failed with HTTP ${status}: ${message}`);
		this.name = "RyuHttpError";
		this.path = path;
		this.status = status;
	}
}

interface RequestTimer {
	clear: () => void;
	signal: AbortSignal;
}

function timeoutSignal(timeoutMs: number): RequestTimer {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function errorMessage(value: JsonValue): string {
	const text = nonemptyString(value);
	if (text !== null) {
		return text;
	}
	const record = jsonRecord(value);
	if (record) {
		for (const key of ["error", "message", "detail"]) {
			const detail = nonemptyString(record[key]);
			if (detail !== null) {
				return detail;
			}
		}
	}
	return "The node returned an unexpected response.";
}

function redact(message: string, token: string | null): string {
	if (!token) {
		return message;
	}
	return message.replaceAll(token, "[REDACTED]");
}

function parseJsonText(text: string): JsonValue {
	if (text.trim().length === 0) {
		return null;
	}
	try {
		return JsonValueSchema.parse(JSON.parse(text));
	} catch {
		return text.slice(0, 1000);
	}
}

function normalizeHealth(value: JsonValue): NodeHealth {
	const raw = jsonRecord(value) ?? {};
	return {
		capabilities: z
			.array(JsonValueSchema)
			.catch(() => [])
			.parse(raw.capabilities),
		channel: z.string().nullable().catch(null).parse(raw.channel),
		status: z.string().catch("unknown").parse(raw.status),
		version: z.string().nullable().catch(null).parse(raw.version),
	};
}

function normalizeInfo(value: JsonValue): NodeInfo {
	const raw = jsonRecord(value) ?? {};
	return {
		...raw,
		hostname: z.string().nullable().catch(null).parse(raw.hostname),
		managed: raw.managed === true,
		orgId: z.string().nullable().catch(null).parse(raw.org_id),
		orgName: z.string().nullable().catch(null).parse(raw.org_name),
		os: z.string().nullable().catch(null).parse(raw.os),
	};
}

interface VaultExportRequest {
	environment?: string;
	format: "json";
	names: string[];
	path: string;
}
type VaultCredentials =
	| { roleId: string; secretId: string }
	| { identity: string; jwt: string };
interface RequestOptions {
	accept?: string;
	auth?: RequestAuth;
	body?:
		| ChatRequest
		| RunEvalsRequest
		| ToolRequest
		| VaultCredentials
		| VaultExportRequest;
	method?: string;
	timeoutMs: number;
}
interface OpenedResponse {
	response: Response;
	timer: RequestTimer;
}

/** IPv4 127.0.0.0/8 or IPv6 ::1, as `URL.hostname` spells them. */
function isLiteralLoopback(hostname: string): boolean {
	return hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Node, vault, and OIDC credentials travel only over HTTPS, or plain HTTP to a
 * literal loopback address (a node on the runner itself). Throws otherwise.
 */
export function assertSecureNodeUrl(value: string): void {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`Ryu node URL is invalid: '${value}'.`);
	}
	if (parsed.protocol === "https:") {
		return;
	}
	if (parsed.protocol === "http:" && isLiteralLoopback(parsed.hostname)) {
		return;
	}
	throw new Error(
		"Ryu node URL must use https (plain http is allowed only for 127.0.0.1 or [::1])."
	);
}

export class RyuNodeClient {
	private readonly fetchImpl: FetchLike;
	private readonly target: ResolvedTarget;

	constructor(target: ResolvedTarget, fetchImpl: FetchLike = fetch) {
		this.target = target;
		this.fetchImpl = fetchImpl;
	}

	private url(path: string): string {
		const url = `${this.target.url}${path}`;
		// Checked at the request boundary too, so no caller can attach a
		// credential to cleartext transport.
		assertSecureNodeUrl(url);
		return url;
	}

	private headers(extra: Record<string, string>, auth: RequestAuth): Headers {
		const headers = new Headers({
			Accept: "application/json",
			"Content-Type": "application/json",
		});
		if (auth === "node" && this.target.token) {
			headers.set("Authorization", `Bearer ${this.target.token}`);
		} else if (auth !== "node" && auth !== "none") {
			headers.set(VAULT_TOKEN_HEADER, auth.vaultToken);
		}
		for (const [name, value] of Object.entries(extra)) {
			headers.set(name, value);
		}
		return headers;
	}

	private async request(
		path: string,
		options: RequestOptions
	): Promise<OpenedResponse> {
		// Validate the destination before any credential header or body exists.
		const url = this.url(path);
		const timer = timeoutSignal(options.timeoutMs);
		try {
			const response = await this.fetchImpl(url, {
				body:
					options.body === undefined ? undefined : JSON.stringify(options.body),
				headers: this.headers(
					{ Accept: options.accept ?? "application/json" },
					options.auth ?? "node"
				),
				method: options.method ?? "GET",
				// Every request carries a bearer, a vault token, or login
				// credentials; a redirect must not move them anywhere else.
				redirect: "error",
				signal: timer.signal,
			});
			return { response, timer };
		} catch (error) {
			timer.clear();
			if (timer.signal.aborted) {
				throw new Error(`${path} timed out after ${options.timeoutMs}ms.`);
			}
			throw new Error(
				`${path} could not reach the Ryu node: ${redact(error instanceof Error ? error.message : String(error), this.target.token)}`
			);
		}
	}

	private async json(
		path: string,
		options: RequestOptions
	): Promise<JsonValue> {
		const { response, timer } = await this.request(path, options);
		try {
			const text = await response.text();
			if (timer.signal.aborted) {
				throw new Error("response body timed out");
			}
			const parsed = parseJsonText(text);
			if (!response.ok) {
				const vaultToken =
					options.auth && options.auth !== "node" && options.auth !== "none"
						? options.auth.vaultToken
						: null;
				throw new RyuHttpError(
					path,
					response.status,
					redact(redact(errorMessage(parsed), this.target.token), vaultToken)
				);
			}
			return parsed;
		} catch (error) {
			if (timer.signal.aborted) {
				throw new Error(`${path} timed out after ${options.timeoutMs}ms.`);
			}
			throw error;
		} finally {
			timer.clear();
		}
	}

	/** Exchange AppRole credentials or an OIDC JWT for a short-lived vault token. */
	async vaultLogin(
		credentials: VaultCredentials,
		timeoutMs: number
	): Promise<VaultLoginResult> {
		const path =
			"roleId" in credentials
				? "/api/vault/auth/approle/login"
				: "/api/vault/auth/jwt/login";
		const result = await this.json(path, {
			auth: "none",
			body: credentials,
			method: "POST",
			timeoutMs,
		});
		const token = jsonRecord(jsonRecord(result)?.token);
		const tokenValue = nonemptyString(token?.token);
		if (!token || tokenValue === null) {
			throw new Error(`${path} returned no vault token.`);
		}
		return {
			accessor: String(token.accessor ?? ""),
			expiresAt: String(token.expiresAt ?? ""),
			identityId: String(token.identityId ?? ""),
			token: tokenValue,
		};
	}

	/** Fetch node-scoped values the vault token may read, as a name→value map. */
	async vaultExport(
		vaultToken: string,
		selection: { environment: string | null; names: string[]; path: string },
		timeoutMs: number
	): Promise<Record<string, string>> {
		const body: VaultExportRequest = {
			format: "json",
			names: selection.names,
			path: selection.path,
		};
		if (selection.environment) {
			body.environment = selection.environment;
		}
		const result = await this.json("/api/vault/agent/export", {
			auth: { vaultToken },
			body,
			method: "POST",
			timeoutMs,
		});
		const content = z.string().safeParse(jsonRecord(result)?.content);
		const parsed = content.success
			? JsonRecordSchema.safeParse(JSON.parse(content.data))
			: null;
		if (!parsed?.success) {
			throw new Error("/api/vault/agent/export returned no JSON object.");
		}
		const values: Record<string, string> = {};
		for (const [name, value] of Object.entries(parsed.data)) {
			const text = z.string().safeParse(value);
			if (text.success) {
				values[name] = text.data;
			}
		}
		return values;
	}

	/** Revoke the presented vault token. */
	async vaultRevoke(vaultToken: string, timeoutMs: number): Promise<void> {
		await this.json("/api/vault/agent/self/revoke", {
			auth: { vaultToken },
			method: "POST",
			timeoutMs,
		});
	}

	/** Check health and node info. With `infoOptional` (a vault-only run that
	 *  holds no node token), an unauthorized `/api/system/info` is reported as
	 *  unknown info instead of failing, except in `managed` mode where the
	 *  managed flag must be verified. */
	async validate(
		mode: TargetMode,
		timeoutMs: number,
		options: { infoOptional?: boolean } = {}
	): Promise<NodeSnapshot> {
		let health: NodeHealth | null = null;
		let lastError: Error | null = null;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				const rawHealth = await this.json("/api/health", {
					timeoutMs,
				});
				health = normalizeHealth(rawHealth);
				break;
			} catch (error) {
				lastError =
					error instanceof Error
						? error
						: new Error("Ryu node health check failed.");
				if (attempt === 0) {
					await new Promise<void>((resolve) => setTimeout(resolve, 250));
				}
			}
		}
		if (health === null) {
			throw lastError instanceof Error
				? lastError
				: new Error("Ryu node health check failed.");
		}

		let rawInfo: JsonValue;
		try {
			rawInfo = await this.json("/api/system/info", { timeoutMs });
		} catch (error) {
			const unauthorized =
				error instanceof RyuHttpError &&
				(error.status === 401 || error.status === 403);
			if (!(options.infoOptional && unauthorized && mode !== "managed")) {
				throw error;
			}
			rawInfo = {};
		}
		const info = normalizeInfo(rawInfo);
		if (mode === "managed" && !info.managed) {
			throw new Error(
				"The selected target was 'managed', but the node reported managed=false. Check the managed node URL."
			);
		}
		return { health, info, mode, url: this.target.url };
	}

	async runChat(
		body: ChatRequest,
		timeoutMs: number,
		callbacks?: StreamCallbacks
	): Promise<ChatResult> {
		const opened = await this.request("/api/chat/stream", {
			accept: "text/event-stream",
			body,
			method: "POST",
			timeoutMs,
		});
		const { response, timer } = opened;
		try {
			if (!response.ok) {
				const text = await response.text();
				throw new RyuHttpError(
					"/api/chat/stream",
					response.status,
					redact(errorMessage(parseJsonText(text)), this.target.token)
				);
			}
			if (!response.body) {
				throw new Error("/api/chat/stream returned no response body.");
			}
			const result = await parseCoreChatStream(
				response.body,
				body.conversation_id,
				callbacks
			);
			if (!result.finished) {
				throw new Error("/api/chat/stream ended before a completion frame.");
			}
			return result;
		} catch (error) {
			if (timer.signal.aborted) {
				throw new Error(`/api/chat/stream timed out after ${timeoutMs}ms.`);
			}
			if (error instanceof Error && this.target.token) {
				const safeMessage = redact(error.message, this.target.token);
				if (safeMessage !== error.message) {
					throw new Error(safeMessage);
				}
			}
			throw error;
		} finally {
			timer.clear();
		}
	}

	/** Replay an eval dataset through Core's Gateway proxy. */
	runEvals(body: RunEvalsRequest, timeoutMs: number): Promise<JsonValue> {
		return this.json("/api/gateway/evals/run", {
			body,
			method: "POST",
			timeoutMs,
		});
	}

	/** Read the shared Gateway evaluator catalog through Core. */
	evaluators(timeoutMs: number): Promise<JsonValue> {
		return this.json("/api/gateway/evaluators", { timeoutMs });
	}

	async callTool(body: ToolRequest, timeoutMs: number): Promise<ToolResult> {
		const { response, timer } = await this.request("/api/mcp/tools/call", {
			body,
			method: "POST",
			timeoutMs,
		});
		try {
			const text = await response.text();
			if (timer.signal.aborted) {
				throw new Error("response body timed out");
			}
			const parsed = parseJsonText(text);
			if (!response.ok) {
				throw new RyuHttpError(
					"/api/mcp/tools/call",
					response.status,
					redact(errorMessage(parsed), this.target.token)
				);
			}
			const raw = jsonRecord(parsed) ?? {};
			return {
				error: z.string().nullable().catch(null).parse(raw.error),
				ok: raw.ok !== false,
				output: raw.output,
			};
		} catch (error) {
			if (timer.signal.aborted) {
				throw new Error(`/api/mcp/tools/call timed out after ${timeoutMs}ms.`);
			}
			throw error;
		} finally {
			timer.clear();
		}
	}
}
