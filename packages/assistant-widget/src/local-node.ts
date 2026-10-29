import { SseFrameDecoder } from "@ryuhq/protocol/sse";
import { z } from "zod";

export interface LocalNodeConfig {
	baseUrl: string;
	token: string | null;
}

const LocalNodeHealthSchema = z.object({
	capabilities: z.json().optional().catch(undefined),
	channel: z.string().optional().catch(undefined),
	status: z.string().catch("ok"),
	version: z.string().optional().catch(undefined),
});

export type LocalNodeHealth = z.infer<typeof LocalNodeHealthSchema>;

export interface LocalNodeChatMessage {
	content: string;
	role: "assistant" | "system" | "user";
}

export interface LocalNodeChatOptions {
	onDelta?: (text: string) => void;
	signal?: AbortSignal;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const MAX_ERROR_BODY_CHARS = 800;
const MAX_ASSISTANT_CHARS = 12_000;

function normalizedHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}

export function isLoopbackNodeUrl(value: string): boolean {
	try {
		const url = new URL(value);
		const hostname = normalizedHostname(url.hostname);
		return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith(".localhost");
	} catch {
		return false;
	}
}

/** Normalize a node base URL and reject URLs that could hide a credential. */
export function normalizeNodeUrl(value: string): string {
	const url = new URL(value.trim());
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Use an http:// or https:// node address.");
	}
	if (url.username || url.password) {
		throw new Error("Node addresses cannot contain embedded credentials.");
	}
	if (url.search || url.hash) {
		throw new Error(
			"Remove the query string and fragment from the node address."
		);
	}
	url.pathname = url.pathname.replace(/\/+$/, "");
	return url.toString().replace(/\/$/, "");
}

export function validateNodeUrl(value: string, allowRemote: boolean): string {
	const normalized = normalizeNodeUrl(value);
	if (!(allowRemote || isLoopbackNodeUrl(normalized))) {
		throw new Error(
			"This first connection is limited to this computer. Enable remote node access only when you trust the node and its network."
		);
	}
	return normalized;
}

function authHeaders(token: string | null): HeadersInit {
	return token ? { Authorization: `Bearer ${token}` } : {};
}

async function responseError(
	response: Response,
	fallback: string
): Promise<Error> {
	let detail = "";
	try {
		detail = (await response.text()).trim().slice(0, MAX_ERROR_BODY_CHARS);
	} catch {
		// The status is still useful when the node closes the connection early.
	}
	if (response.status === 401 || response.status === 403) {
		return new Error(
			"The node rejected this token. Copy the current node token and try again."
		);
	}
	return new Error(detail || `${fallback} (${response.status}).`);
}

function describeNetworkError(error: Error | undefined): Error {
	if (error instanceof Error && error.name === "AbortError") {
		return error;
	}
	return new Error(
		"Could not reach the node. Check that Ryu Core is running and that this browser origin is allowed by its CORS settings."
	);
}

export async function checkLocalNode(
	config: LocalNodeConfig,
	signal?: AbortSignal
): Promise<LocalNodeHealth> {
	let healthResponse: Response;
	try {
		healthResponse = await fetch(`${config.baseUrl}/api/health`, {
			cache: "no-store",
			credentials: "omit",
			headers: authHeaders(config.token),
			signal,
		});
	} catch (error) {
		throw describeNetworkError(z.instanceof(Error).safeParse(error).data);
	}
	if (!healthResponse.ok) {
		throw await responseError(healthResponse, "Node health check failed");
	}

	let agentsResponse: Response;
	try {
		agentsResponse = await fetch(`${config.baseUrl}/api/agents`, {
			cache: "no-store",
			credentials: "omit",
			headers: authHeaders(config.token),
			signal,
		});
	} catch (error) {
		throw describeNetworkError(z.instanceof(Error).safeParse(error).data);
	}
	if (!agentsResponse.ok) {
		throw await responseError(agentsResponse, "Node authentication failed");
	}

	const payload = LocalNodeHealthSchema.safeParse(
		await healthResponse.json().catch(() => ({}))
	);
	return payload.success ? payload.data : { status: "ok" };
}

const LocalNodeFrameSchema = z.object({
	type: z.string().optional().catch(undefined),
	errorText: z.string().optional().catch(undefined),
	error: z.string().optional().catch(undefined),
	delta: z.string().optional().catch(undefined),
	choices: z
		.array(
			z.object({
				delta: z
					.object({ content: z.string().optional().catch(undefined) })
					.optional()
					.catch(undefined),
				text: z.string().optional().catch(undefined),
			})
		)
		.optional()
		.catch(undefined),
});

function parseTextFrame(data: string): string | "done" | null {
	if (data === "[DONE]") {
		return "done";
	}
	try {
		const decoded = LocalNodeFrameSchema.safeParse(JSON.parse(data));
		if (!decoded.success) {
			return null;
		}
		const frame = decoded.data;
		if (frame.type === "error") {
			throw new Error(
				frame.errorText ?? frame.error ?? "The local node returned an error."
			);
		}
		if (frame.type === "text-delta" && frame.delta !== undefined) {
			return frame.delta;
		}
		return (
			frame.choices?.[0]?.delta?.content ?? frame.choices?.[0]?.text ?? null
		);
	} catch (error) {
		if (error instanceof SyntaxError) {
			return null;
		}
		throw error;
	}
}

/** Stream one non-persistent, visitor-scoped turn through a running Core node. */
export async function runLocalNodeChat(
	config: LocalNodeConfig,
	messages: readonly LocalNodeChatMessage[],
	options: LocalNodeChatOptions = {}
): Promise<string> {
	let response: Response;
	try {
		response = await fetch(`${config.baseUrl}/api/chat/stream`, {
			body: JSON.stringify({
				// Core seeds the batteries-included agent as `ryu`; `default` is a
				// routing concept, not a durable agent id and fails on a fresh node.
				agent_id: "ryu",
				browser_context_consent: false,
				browser_surface: "website-assistant",
				companion_source: false,
				messages,
				persist: false,
			}),
			cache: "no-store",
			credentials: "omit",
			headers: {
				...authHeaders(config.token),
				"Content-Type": "application/json",
				Accept: "text/event-stream",
			},
			method: "POST",
			signal: options.signal,
		});
	} catch (error) {
		throw describeNetworkError(z.instanceof(Error).safeParse(error).data);
	}
	if (!(response.ok && response.body)) {
		throw await responseError(response, "Local node chat failed");
	}

	const reader = response.body.getReader();
	// Bounded incremental framing: a peer that never ends an event is cut off
	// at the frame limit instead of growing this tab's memory.
	const decoder = new SseFrameDecoder();
	let answer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				decoder.finish();
				break;
			}
			for (const frame of decoder.push(value)) {
				const data = frame
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice("data:".length).trim())
					.join("\n");
				if (data) {
					const parsed = parseTextFrame(data);
					if (parsed === "done") {
						return answer;
					}
					if (parsed && answer.length < MAX_ASSISTANT_CHARS) {
						const remaining = MAX_ASSISTANT_CHARS - answer.length;
						const delta = parsed.slice(0, remaining);
						answer += delta;
						options.onDelta?.(delta);
					}
				}
			}
		}
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw error;
		}
		throw error instanceof Error ? error : new Error(String(error));
	} finally {
		decoder.finish();
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	return answer;
}
