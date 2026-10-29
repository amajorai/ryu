import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";

// In-memory performance metrics for troubleshooting, recorded only in a dev
// build or when the user turns Developer Mode on.
//
// The question this answers is the one that used to need a packet capture: "the
// chat felt slow — was that the model, the network, Core, or the renderer?" Two
// probes are enough to separate those:
//
//   - EVERY Core API call, through the one `request()` choke point in
//     `lib/api/client.ts`: method, normalized path, status, duration.
//   - EVERY chat turn, through the `fetch` the AI SDK transport is constructed
//     with: time to first byte (the model thinking), streaming duration (the
//     model writing), bytes and chunk count (how much came back).
//
// Both are RING BUFFERS in memory. Nothing is written to disk, nothing is sent
// anywhere: this module has no network calls of its own, matching the posture
// `console-buffer.ts` already sets for developer-mode capture. The contents
// reach the outside world only if the user clicks "Collect & copy diagnostics",
// which puts them on the clipboard.
//
// OVERHEAD WHEN OFF: the gate is checked before anything is allocated, and it
// reads a cached boolean rather than localStorage. A disabled recorder costs one
// branch. `instrumentedFetch` degrades to a direct `fetch` call with no stream
// wrapper at all, so a turn is not even piped through a TransformStream.

const DEV_MODE_KEY = "ryu_developer_mode";

/** Cached gate. `null` = not yet read. */
let enabled: boolean | null = null;

function readGate(): boolean {
	if (import.meta.env.DEV) {
		return true;
	}
	try {
		return localStorage.getItem(DEV_MODE_KEY) === "true";
	} catch {
		return false;
	}
}

/**
 * Whether metrics are being recorded: a dev build, or Developer Mode on.
 *
 * Both, because they answer different needs — the dev build wants them always,
 * and a user hitting a problem in a release build needs to be able to turn them
 * on without reinstalling anything.
 */
export function isDevMetricsEnabled(): boolean {
	if (enabled === null) {
		enabled = readGate();
	}
	return enabled;
}

/**
 * Re-read the gate. Called when the Developer Mode switch flips, so recording
 * starts (or stops) without a reload.
 */
export function refreshDevMetricsGate(): boolean {
	enabled = readGate();
	notify();
	return enabled;
}

// ── Samples ──────────────────────────────────────────────────────────────────

export interface HttpSample {
	/** unix ms when the call STARTED. */
	at: number;
	method: string;
	/** Wall-clock duration including body parse. */
	ms: number;
	/** Normalized path (ids replaced) — the aggregation key. */
	path: string;
	/** HTTP status, or 0 when the request never got a response (offline, abort). */
	status: number;
}

export interface TurnSample {
	/** unix ms when the turn was sent. */
	at: number;
	/** Total bytes received in the stream body. */
	bytes: number;
	/** Number of stream chunks — a rough proxy for how choppy the stream was. */
	chunks: number;
	/** Wall-clock from send to the stream closing. */
	ms: number;
	/** The endpoint the turn was sent to (normalized). */
	path: string;
	status: number;
	/**
	 * Time from send to the FIRST byte of the response body. This is the number
	 * that maps to "why did it sit there doing nothing" — everything after it is
	 * the model writing, everything before it is queueing, routing, and thinking.
	 */
	ttftMs: number | null;
}

const MAX_SAMPLES = 500;

const httpSamples: HttpSample[] = [];
const turnSamples: TurnSample[] = [];

const listeners = new Set<() => void>();
/** Bumped on every recorded sample so `useSyncExternalStore` can snapshot it. */
let revision = 0;

function notify(): void {
	revision++;
	for (const listener of listeners) {
		listener();
	}
}

/** Subscribe to any change (new sample, cleared, gate flipped). */
export function subscribeDevMetrics(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Monotonic revision counter — the `getSnapshot` for a React subscription. */
export function getDevMetricsRevision(): number {
	return revision;
}

function push<T>(buffer: T[], sample: T): void {
	buffer.push(sample);
	if (buffer.length > MAX_SAMPLES) {
		buffer.shift();
	}
	notify();
}

// Ids inside a path destroy aggregation — `/api/conversations/<uuid>/messages`
// would be its own row for every conversation. Collapse the id-shaped segments
// so a path aggregates across calls. Top-level regexes (never rebuilt per call).
const UUID_RE =
	/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LONG_HEX_RE = /\/[0-9a-f]{16,}/gi;
const NUMERIC_RE = /\/\d+(?=\/|$)/g;
const QUERY_RE = /\?.*$/;

/**
 * The pathname of a request URL, normalized. Relative URLs resolve against the
 * document when there is one; a non-browser caller (a test, a worker) still gets
 * a usable key instead of a throw, because a metrics probe must never be the
 * reason a request fails.
 */
function pathOf(url: string): string {
	try {
		return normalizePath(
			new URL(url, globalThis.location?.href ?? "http://localhost").pathname
		);
	} catch {
		return normalizePath(url);
	}
}

/** Collapse ids and drop the query string, so calls aggregate by shape. */
export function normalizePath(path: string): string {
	return path
		.replace(QUERY_RE, "")
		.replace(UUID_RE, "/:id")
		.replace(LONG_HEX_RE, "/:id")
		.replace(NUMERIC_RE, "/:n");
}

/** Record one completed (or failed) API call. No-op when metrics are off. */
export function recordHttpSample(sample: HttpSample): void {
	if (!isDevMetricsEnabled()) {
		return;
	}
	push(httpSamples, sample);
}

/** Record one completed chat turn. No-op when metrics are off. */
export function recordTurnSample(sample: TurnSample): void {
	if (!isDevMetricsEnabled()) {
		return;
	}
	push(turnSamples, sample);
}

export function getHttpSamples(): readonly HttpSample[] {
	return httpSamples;
}

export function getTurnSamples(): readonly TurnSample[] {
	return turnSamples;
}

/** Drop everything recorded so far (the panel's "Clear" action). */
export function clearDevMetrics(): void {
	httpSamples.length = 0;
	turnSamples.length = 0;
	notify();
}

// ── Aggregation ──────────────────────────────────────────────────────────────

export interface PathStat {
	count: number;
	/** Calls that came back non-2xx (or never came back). */
	errors: number;
	max: number;
	median: number;
	/** 95th percentile — the number that shows the stalls a mean hides. */
	p95: number;
	path: string;
}

/**
 * Percentile by nearest-rank on an already-sorted array. Nearest-rank rather
 * than interpolation because these samples are counted in the tens, where
 * interpolating invents precision that is not in the data.
 */
function percentile(sorted: number[], fraction: number): number {
	if (sorted.length === 0) {
		return 0;
	}
	const rank = Math.ceil(fraction * sorted.length) - 1;
	return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}

/** Per-path timing rows, slowest p95 first. */
export function summarizeHttp(samples: readonly HttpSample[]): PathStat[] {
	const byPath = new Map<string, { errors: number; times: number[] }>();
	for (const sample of samples) {
		let row = byPath.get(sample.path);
		if (!row) {
			row = { times: [], errors: 0 };
			byPath.set(sample.path, row);
		}
		row.times.push(sample.ms);
		if (sample.status === 0 || sample.status >= 400) {
			row.errors++;
		}
	}
	const stats: PathStat[] = [];
	for (const [path, row] of byPath) {
		const sorted = [...row.times].sort((a, b) => a - b);
		stats.push({
			path,
			count: sorted.length,
			errors: row.errors,
			median: percentile(sorted, 0.5),
			p95: percentile(sorted, 0.95),
			max: sorted.at(-1) ?? 0,
		});
	}
	stats.sort((a, b) => b.p95 - a.p95);
	return stats;
}

export interface TurnStat {
	count: number;
	medianTotal: number;
	medianTtft: number;
	p95Total: number;
	p95Ttft: number;
}

/** Aggregate turn timings. Turns with no first byte are excluded from TTFT. */
export function summarizeTurns(samples: readonly TurnSample[]): TurnStat {
	const totals = samples.map((s) => s.ms).sort((a, b) => a - b);
	const ttfts = samples
		.map((s) => s.ttftMs)
		.filter((v): v is number => v !== null)
		.sort((a, b) => a - b);
	return {
		count: samples.length,
		medianTotal: percentile(totals, 0.5),
		p95Total: percentile(totals, 0.95),
		medianTtft: percentile(ttfts, 0.5),
		p95Ttft: percentile(ttfts, 0.95),
	};
}

// ── Chat-turn instrumentation ────────────────────────────────────────────────

/**
 * A `fetch` for the AI SDK chat transport that times the turn.
 *
 * The response body is piped through a pass-through `TransformStream` so the
 * first chunk timestamps TTFT and the stream's close timestamps the total —
 * neither is observable from `useChat`'s callbacks, which only fire once the
 * whole turn is assembled. The pass-through adds no buffering: chunks are
 * forwarded as they arrive.
 *
 * When metrics are off this is exactly `fetch`, with no wrapper on the body.
 */
export const instrumentedFetch: typeof fetch = Object.assign(
	(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		if (!isDevMetricsEnabled()) {
			return fetch(input, init);
		}
		const started = performance.now();
		const at = Date.now();
		const url = isNativeText(input)
			? input
			: input instanceof URL
				? input.href
				: input.url;
		const path = pathOf(url);

		return fetch(input, init).then(
			(response) => {
				if (!response.body) {
					recordTurnSample({
						at,
						path,
						status: response.status,
						ttftMs: null,
						ms: performance.now() - started,
						bytes: 0,
						chunks: 0,
					});
					return response;
				}
				let ttftMs: number | null = null;
				let bytes = 0;
				let chunks = 0;
				const meter = new TransformStream<Uint8Array, Uint8Array>({
					transform(chunk, controller) {
						if (ttftMs === null) {
							ttftMs = performance.now() - started;
						}
						bytes += chunk.byteLength;
						chunks++;
						controller.enqueue(chunk);
					},
					flush() {
						recordTurnSample({
							at,
							path,
							status: response.status,
							ttftMs,
							ms: performance.now() - started,
							bytes,
							chunks,
						});
					},
				});
				return new Response(response.body.pipeThrough(meter), {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				});
			},
			(error) => {
				recordTurnSample({
					at,
					path,
					status: 0,
					ttftMs: null,
					ms: performance.now() - started,
					bytes: 0,
					chunks: 0,
				});
				throw error;
			}
		);
	},
	// Bun's fetch type carries preconnect; DOM-only builds do not declare it.
	{ preconnect: Reflect.get(fetch, "preconnect") }
);

// ── Text rendering (diagnostics bundle) ──────────────────────────────────────

const ms = (value: number): string => `${Math.round(value)}ms`;

/**
 * The metrics section of the diagnostics bundle. Returns an empty string when
 * nothing was recorded, so `collectDiagnostics` can leave the section out
 * rather than print an empty table.
 */
export function getDevMetricsText(): string {
	if (httpSamples.length === 0 && turnSamples.length === 0) {
		return "";
	}
	const lines: string[] = [];
	if (turnSamples.length > 0) {
		const turns = summarizeTurns(turnSamples);
		lines.push(
			`chat turns: ${turns.count} | first token median ${ms(turns.medianTtft)} p95 ${ms(turns.p95Ttft)} | total median ${ms(turns.medianTotal)} p95 ${ms(turns.p95Total)}`
		);
		lines.push("");
		lines.push("recent turns (newest last):");
		for (const turn of turnSamples.slice(-10)) {
			lines.push(
				`  ${new Date(turn.at).toISOString()} ${turn.status} ttft ${turn.ttftMs === null ? "-" : ms(turn.ttftMs)} total ${ms(turn.ms)} ${turn.bytes}B in ${turn.chunks} chunks`
			);
		}
		lines.push("");
	}
	if (httpSamples.length > 0) {
		lines.push(`api calls: ${httpSamples.length} (slowest p95 first)`);
		for (const stat of summarizeHttp(httpSamples).slice(0, 25)) {
			lines.push(
				`  ${stat.path} ×${stat.count} median ${ms(stat.median)} p95 ${ms(stat.p95)} max ${ms(stat.max)}${stat.errors > 0 ? ` errors ${stat.errors}` : ""}`
			);
		}
	}
	return lines.join("\n");
}
