// Main-process client for Ryu Core's quests API (:7980).
//
// Core owns the quest brain (it watches Shadow context and judges whether a task
// is done); the island is a thin surface. This module confirms/rejects a detected
// completion and subscribes to Core's `GET /api/quests/events` SSE so the renderer
// can prompt "looks done — mark it?" when Core detects a finished task. Like the
// other Core clients here, every method degrades gracefully and never rejects.

import type {
	IslandQuest,
	IslandQuestEvent,
	IslandQuestResult,
} from "../../shared/ipc.ts";
import { coreHeaders, loadConfig } from "./config.ts";

/** Reconnect delay for the quest event stream. */
const RECONNECT_DELAY_MS = 3000;
/** Timeout for one-shot accept/dismiss requests. */
const ACTION_TIMEOUT_MS = 10_000;

function reasonFromError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return "unreachable";
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

/** POST a quest suggestion action (accept / dismiss). Never rejects. */
async function postQuestAction(
	id: string,
	path: string
): Promise<IslandQuestResult> {
	const { coreBaseUrl } = loadConfig();
	try {
		const resp = await fetchWithTimeout(
			`${coreBaseUrl}/api/quests/${encodeURIComponent(id)}/${path}`,
			{ method: "POST", headers: coreHeaders() },
			ACTION_TIMEOUT_MS
		);
		if (!resp.ok) {
			return { available: false, reason: `core responded ${resp.status}` };
		}
		const data = (await resp.json()) as { quest?: IslandQuest };
		if (!data.quest) {
			return { available: false, reason: "no quest returned" };
		}
		return { available: true, quest: data.quest };
	} catch (error) {
		return { available: false, reason: reasonFromError(error) };
	}
}

/** Confirm a detected completion via `POST /api/quests/:id/suggestion/accept`. */
export function acceptQuest(id: string): Promise<IslandQuestResult> {
	return postQuestAction(id, "suggestion/accept");
}

/** Reject the pending suggestion via `POST /api/quests/:id/suggestion/dismiss`. */
export function dismissQuest(id: string): Promise<IslandQuestResult> {
	return postQuestAction(id, "suggestion/dismiss");
}

/**
 * Subscribe to Core's quest-event SSE stream, invoking `onEvent` for each event.
 * Runs until `signal` aborts, auto-reconnecting on drop. Errors are swallowed
 * (the island degrades to no quest prompts when Core is down).
 */
export function subscribeQuestEvents(
	onEvent: (event: IslandQuestEvent) => void,
	signal: AbortSignal
): void {
	const run = async (): Promise<void> => {
		while (!signal.aborted) {
			try {
				await pumpEventStream(onEvent, signal);
			} catch {
				// Transient failure — fall through to the reconnect delay.
			}
			if (signal.aborted) {
				return;
			}
			await new Promise<void>((resolve) =>
				setTimeout(resolve, RECONNECT_DELAY_MS)
			);
		}
	};
	run().catch(() => undefined);
}

const SSE_FRAME_SEPARATOR = "\n\n";
const DATA_PREFIX = "data:";

async function pumpEventStream(
	onEvent: (event: IslandQuestEvent) => void,
	signal: AbortSignal
): Promise<void> {
	const { coreBaseUrl } = loadConfig();
	const resp = await fetch(`${coreBaseUrl}/api/quests/events`, {
		method: "GET",
		headers: coreHeaders(),
		signal,
	});
	if (!(resp.ok && resp.body)) {
		throw new Error(`core responded ${resp.status}`);
	}
	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			return;
		}
		buffer += decoder.decode(value, { stream: true });
		let sep = buffer.indexOf(SSE_FRAME_SEPARATOR);
		while (sep !== -1) {
			const frame = buffer.slice(0, sep);
			const data = frame
				.split("\n")
				.filter((line) => line.startsWith(DATA_PREFIX))
				.map((line) => line.slice(DATA_PREFIX.length).trim())
				.join("\n");
			if (data) {
				try {
					onEvent(JSON.parse(data) as IslandQuestEvent);
				} catch {
					// Ignore malformed frames; the next event self-heals the feed.
				}
			}
			buffer = buffer.slice(sep + SSE_FRAME_SEPARATOR.length);
			sep = buffer.indexOf(SSE_FRAME_SEPARATOR);
		}
	}
}
