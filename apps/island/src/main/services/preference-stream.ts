import { z } from "zod";
import { coreHeaders, loadConfig } from "./config.ts";
import { waitForReconnect } from "./reconnect-delay.ts";
import { readSseFrames, sseDataLines } from "./sse-reader.ts";

interface Listener {
	key: string;
	receive: (value: string) => void;
}
const listeners = new Set<Listener>();
let owner: AbortController | null = null;
let activeTarget = "";

function target() {
	const url = `${loadConfig().coreBaseUrl}/api/preferences/stream`;
	const headers = coreHeaders({ Accept: "text/event-stream" });
	return { url, headers, identity: JSON.stringify([url, headers]) };
}

const preferenceEventSchema = z.object({ key: z.string(), value: z.string() });
function dispatch(payload: string, signal: AbortSignal): void {
	let event: z.infer<typeof preferenceEventSchema>;
	try {
		event = preferenceEventSchema.parse(JSON.parse(payload));
	} catch {
		return;
	}
	for (const listener of Array.from(listeners)) {
		if (signal.aborted) {
			return;
		}
		if (listener.key !== event.key || !listeners.has(listener)) {
			continue;
		}
		try {
			listener.receive(event.value);
		} catch {
			/* One consumer cannot stop other preferences. */
		}
	}
}

async function consume(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal
): Promise<void> {
	await readSseFrames(
		body,
		(frame) => {
			for (const payload of sseDataLines(frame)) {
				if (signal.aborted) {
					return;
				}
				dispatch(payload, signal);
			}
		},
		signal
	);
}

async function run(controller: AbortController): Promise<void> {
	while (!controller.signal.aborted) {
		const attempt = new AbortController();
		const abort = () => attempt.abort();
		controller.signal.addEventListener("abort", abort, { once: true });
		try {
			const next = target();
			activeTarget = next.identity;
			const response = await fetch(next.url, {
				headers: next.headers,
				signal: attempt.signal,
			});
			if (response.ok && response.body) {
				await consume(response.body, controller.signal);
			}
		} catch {
			/* A dropped connection retries while listeners remain. */
		} finally {
			attempt.abort();
			controller.signal.removeEventListener("abort", abort);
		}
		await waitForReconnect(controller.signal, 3000);
	}
}

/** Key-scoped listeners share one connection; the final unsubscribe closes it. */
export function subscribePreferenceChanges(
	key: string,
	receive: (value: string) => void
): () => void {
	const listener = { key, receive };
	listeners.add(listener);
	if (!owner || activeTarget !== target().identity) {
		owner?.abort();
		owner = new AbortController();
		void run(owner);
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) {
			owner?.abort();
			owner = null;
			activeTarget = "";
		}
	};
}
