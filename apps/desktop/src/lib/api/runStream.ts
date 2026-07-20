// apps/desktop/src/lib/api/runStream.ts
//
// Reader for Core's `GET /api/runs/stream` SSE feed (issue #128). The endpoint
// is snapshot-first: the first frame is the full run list, then one frame per
// run whose `run_status` transitions. This replaces the desktop's old 3s poll of
// `/api/runs` — the completion-notification logic in `useRuns` keys off the same
// `running → completed/failed` transitions, now pushed instead of diffed.
//
// Follows the repo's fetch + ReadableStream reader convention (NOT EventSource)
// so the node bearer token rides as an `Authorization` header — see
// `apps/desktop/src/lib/api/eventStream.ts` for the shared-connection variant.

import type { RunSummary } from "@/src/hooks/useRuns.ts";
import { type ApiTarget, apiUrl, makeHeaders } from "./client.ts";

const FRAME_SEP = "\n\n";
const DATA_PREFIX = "data:";

/** A parsed frame from the runs stream. */
export type RunStreamFrame =
	| { type: "snapshot"; runs: RunSummary[] }
	| { type: "run"; run: RunSummary };

/** Split accumulated buffer into complete SSE frames, returning the remainder. */
function extractFrames(buffer: string): { frames: string[]; rest: string } {
	const frames: string[] = [];
	let rest = buffer;
	let sep = rest.indexOf(FRAME_SEP);
	while (sep !== -1) {
		frames.push(rest.slice(0, sep));
		rest = rest.slice(sep + FRAME_SEP.length);
		sep = rest.indexOf(FRAME_SEP);
	}
	return { frames, rest };
}

/** Parse one SSE frame's `data:` payload into a typed frame, or `null`. */
function parseFrame(frame: string): RunStreamFrame | null {
	const dataLines: string[] = [];
	for (const line of frame.split("\n")) {
		if (line.startsWith(DATA_PREFIX)) {
			dataLines.push(line.slice(DATA_PREFIX.length).trim());
		}
	}
	if (dataLines.length === 0) {
		// Keep-alive comments carry no payload.
		return null;
	}
	try {
		return JSON.parse(dataLines.join("\n")) as RunStreamFrame;
	} catch {
		// Ignore malformed frames; the next event self-heals the feed.
		return null;
	}
}

/**
 * Open `/api/runs/stream` and invoke `onFrame` for every frame until the stream
 * ends or `signal` aborts. Resolves when the stream closes; rejects on a failed
 * connect so the caller can back off and reconnect.
 */
export async function streamRuns(
	target: ApiTarget,
	onFrame: (frame: RunStreamFrame) => void,
	signal: AbortSignal
): Promise<void> {
	const resp = await fetch(apiUrl(target, "/api/runs/stream"), {
		method: "GET",
		headers: makeHeaders(target.token),
		signal,
	});
	if (!(resp.ok && resp.body)) {
		throw new Error(`runs stream failed: ${resp.status}`);
	}
	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		const { frames, rest } = extractFrames(buffer);
		buffer = rest;
		for (const frame of frames) {
			const parsed = parseFrame(frame);
			if (parsed) {
				onFrame(parsed);
			}
		}
	}
}
