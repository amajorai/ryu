// Shared Ryu Core client for the Raycast extension.
//
// Unlike the Electron command bar, Raycast commands run in a Node context with no
// browser Origin header, so CORS is a non-issue — these talk to Core directly.
// The base URL + optional bearer token + default agent come from the extension
// preferences (configured in Raycast → Extensions → Ryu).

import { getPreferenceValues } from "@raycast/api";

interface Preferences {
	coreUrl: string;
	apiToken?: string;
	defaultAgent?: string;
}

export interface ChatMessage {
	role: "user" | "assistant" | "system";
	content: string;
}

export interface RyuConfig {
	baseUrl: string;
	token: string | null;
	defaultAgent: string | null;
}

const TRAILING_SLASHES = /\/+$/;

/** Resolve the configured Core endpoint + auth from Raycast preferences. */
export function getConfig(): RyuConfig {
	const prefs = getPreferenceValues<Preferences>();
	const baseUrl = (prefs.coreUrl || "http://localhost:7980").replace(
		TRAILING_SLASHES,
		""
	);
	const token = prefs.apiToken?.trim() ? prefs.apiToken.trim() : null;
	const defaultAgent = prefs.defaultAgent?.trim()
		? prefs.defaultAgent.trim()
		: null;
	return { baseUrl, token, defaultAgent };
}

function headers(config: RyuConfig, extra?: Record<string, string>): HeadersInit {
	const base: Record<string, string> = { Accept: "application/json", ...extra };
	if (config.token) {
		base.Authorization = `Bearer ${config.token}`;
	}
	return base;
}

/** One conversation row from `GET /api/conversations`. */
export interface RyuConversation {
	id: string;
	title: string;
}

/** List recent conversations. Throws on an unreachable/erroring Core. */
export async function listConversations(): Promise<RyuConversation[]> {
	const config = getConfig();
	const resp = await fetch(`${config.baseUrl}/api/conversations`, {
		headers: headers(config),
	});
	if (!resp.ok) {
		throw new Error(`Core responded ${resp.status}`);
	}
	const data = (await resp.json()) as {
		conversations?: { id?: unknown; title?: unknown }[];
	};
	const list: RyuConversation[] = [];
	for (const c of data.conversations ?? []) {
		if (typeof c.id === "string") {
			list.push({
				id: c.id,
				title:
					typeof c.title === "string" && c.title.length > 0
						? c.title
						: "Untitled",
			});
		}
	}
	return list;
}

/**
 * Stream a chat turn from Core's AI SDK v6 SSE endpoint, invoking `onDelta` with
 * each text chunk. Resolves with the full assistant text. `signal` aborts it.
 */
export async function streamChat(
	messages: ChatMessage[],
	onDelta: (delta: string) => void,
	options?: { agentId?: string | null; conversationId?: string; signal?: AbortSignal }
): Promise<string> {
	const config = getConfig();
	const agentId = options?.agentId ?? config.defaultAgent ?? undefined;
	const resp = await fetch(`${config.baseUrl}/api/chat/stream`, {
		method: "POST",
		headers: headers(config, { "Content-Type": "application/json" }),
		body: JSON.stringify({
			messages,
			agent_id: agentId,
			conversation_id: options?.conversationId,
			enable_long_term: false,
		}),
		signal: options?.signal,
	});
	if (!(resp.ok && resp.body)) {
		throw new Error(`Core responded ${resp.status}`);
	}

	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let full = "";

	const handleLine = (line: string): void => {
		if (!line.startsWith("data:")) {
			return;
		}
		const payload = line.slice("data:".length).trim();
		if (payload.length === 0 || payload === "[DONE]") {
			return;
		}
		try {
			const part = JSON.parse(payload) as { type?: string; delta?: unknown };
			if (part.type === "text-delta" && typeof part.delta === "string") {
				full += part.delta;
				onDelta(part.delta);
			}
		} catch {
			// Ignore keep-alive comments / malformed frames.
		}
	};

	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		let newlineIndex = buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			handleLine(buffer.slice(0, newlineIndex).replace(/\r$/, ""));
			buffer = buffer.slice(newlineIndex + 1);
			newlineIndex = buffer.indexOf("\n");
		}
	}
	if (buffer.length > 0) {
		handleLine(buffer.replace(/\r$/, ""));
	}
	return full;
}
