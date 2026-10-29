// The canvas's live state, kept outside React Flow's node array (spec 07.5):
// a traffic tick updates counters and pulses here, and only the node that
// changed re-renders through `useSyncExternalStore`. The node array is built
// from the topology alone, so 50 events a second never rebuild it.

import {
	type CanvasCounterMap,
	type CanvasLinkCounts,
	type CanvasNodeCounters,
	createPulseBudget,
	type TrafficPulse,
} from "./model.ts";

/** A pulse the canvas is drawing. */
export interface ActivePulse {
	/** When it was admitted, on the store's clock. */
	born: number;
	id: number;
	pulse: TrafficPulse;
}

export interface CanvasTotals {
	blocked: number;
	/** Requests in the last five seconds, per second. */
	perSecond: number;
	requests: number;
	/** Pulses not drawn because the per-second budget was spent. */
	sampledOut: number;
}

export interface CanvasLiveStoreOptions {
	now?: () => number;
	/** How long a pulse stays drawn, in milliseconds. */
	pulseLifetimeMs?: number;
	/** Batches notifications; defaults to one animation frame. */
	schedule?: (flush: () => void) => void;
}

const EMPTY: CanvasNodeCounters = Object.freeze({ blocked: 0, requests: 0 });
const LATENCY_SAMPLES = 64;
const RATE_WINDOW_MS = 5000;
const DEFAULT_PULSE_LIFETIME_MS = 2200;

function defaultSchedule(flush: () => void): void {
	if (typeof window !== "undefined" && window.requestAnimationFrame) {
		window.requestAnimationFrame(() => flush());
		return;
	}
	setTimeout(flush, 16);
}

function median(samples: readonly number[]): number | undefined {
	if (samples.length === 0) {
		return;
	}
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

export function createCanvasLiveStore(options: CanvasLiveStoreOptions = {}) {
	const now = options.now ?? (() => Date.now());
	const schedule = options.schedule ?? defaultSchedule;
	const lifetime = options.pulseLifetimeMs ?? DEFAULT_PULSE_LIFETIME_MS;
	const admit = createPulseBudget();

	const working = new Map<string, CanvasNodeCounters>();
	const latency = new Map<string, number[]>();
	const snapshots = new Map<string, CanvasNodeCounters>();
	const edgeCounts = new Map<string, number>();
	const dirty = new Set<string>();
	const nodeListeners = new Map<string, Set<() => void>>();
	const listeners = new Set<() => void>();
	const arrivals: number[] = [];

	let pulses: ActivePulse[] = [];
	let nextPulseId = 1;
	let motion = true;
	let totals: CanvasTotals = {
		blocked: 0,
		perSecond: 0,
		requests: 0,
		sampledOut: 0,
	};
	let workingTotals = { ...totals };
	let pending = false;

	const flush = () => {
		pending = false;
		const at = now();
		const kept = pulses.filter((entry) => at - entry.born < lifetime);
		if (kept.length !== pulses.length) {
			pulses = kept;
		}
		for (const id of dirty) {
			const counters = working.get(id);
			if (counters) {
				// Aggregated hosts send their own median; per-request hosts never
				// set one, so the sampled median stands for them.
				snapshots.set(id, {
					...counters,
					p50Ms: median(latency.get(id) ?? []) ?? counters.p50Ms,
				});
			}
			for (const listener of nodeListeners.get(id) ?? []) {
				listener();
			}
		}
		dirty.clear();
		while (arrivals.length > 0 && (arrivals[0] ?? 0) <= at - RATE_WINDOW_MS) {
			arrivals.shift();
		}
		totals = {
			...workingTotals,
			perSecond: arrivals.length / (RATE_WINDOW_MS / 1000),
		};
		for (const listener of listeners) {
			listener();
		}
	};

	const request = () => {
		if (!pending) {
			pending = true;
			schedule(flush);
		}
	};

	const bump = (id: string, change: (counters: CanvasNodeCounters) => void) => {
		const counters = working.get(id) ?? { blocked: 0, requests: 0 };
		change(counters);
		working.set(id, counters);
		dirty.add(id);
	};

	return {
		/** Count a pulse exactly, and draw it if the budget allows. */
		ingest(pulse: TrafficPulse): void {
			const at = now();
			arrivals.push(at);
			workingTotals.requests += 1;
			const last = pulse.path.length - 1;
			pulse.path.forEach((id, index) => {
				bump(id, (counters) => {
					counters.requests += 1;
					if (index === last && pulse.outcome === "block") {
						counters.blocked += 1;
					}
					if (index === last && pulse.costMicroUsd) {
						counters.costMicroUsd =
							(counters.costMicroUsd ?? 0) + pulse.costMicroUsd;
					}
				});
				if (index > 0) {
					const key = `${pulse.path[index - 1]}->${id}`;
					edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
				}
			});
			if (pulse.outcome === "block") {
				workingTotals.blocked += 1;
			}
			const end = pulse.path[last];
			if (end && typeof pulse.latencyMs === "number") {
				const samples = latency.get(end) ?? [];
				samples.push(pulse.latencyMs);
				if (samples.length > LATENCY_SAMPLES) {
					samples.shift();
				}
				latency.set(end, samples);
			}
			if (motion && pulse.path.length > 1) {
				if (admit(pulse, at)) {
					pulses = [...pulses, { born: at, id: nextPulseId, pulse }];
					nextPulseId += 1;
				} else {
					workingTotals.sampledOut += 1;
				}
			}
			request();
		},
		/**
		 * Replace every counter with an aggregated snapshot (hosted views).
		 * Link counts, when given, replace every link's count too.
		 */
		replaceCounters(next: CanvasCounterMap, links?: CanvasLinkCounts): void {
			if (links) {
				edgeCounts.clear();
				for (const [key, total] of Object.entries(links)) {
					edgeCounts.set(key, total);
				}
			}
			let requests = 0;
			let blocked = 0;
			for (const id of new Set([...working.keys(), ...Object.keys(next)])) {
				const counters = next[id];
				if (counters) {
					working.set(id, { ...counters });
					blocked += counters.blocked;
				} else {
					working.delete(id);
					snapshots.delete(id);
				}
				dirty.add(id);
			}
			for (const counters of Object.values(next)) {
				requests = Math.max(requests, counters?.requests ?? 0);
			}
			workingTotals = { ...workingTotals, blocked, requests };
			request();
		},
		setMotion(enabled: boolean): void {
			motion = enabled;
			if (!enabled && pulses.length > 0) {
				pulses = [];
				request();
			}
		},
		/** Drop pulses past their lifetime; the canvas calls this on a timer. */
		sweep(): void {
			if (pulses.length > 0) {
				request();
			}
		},
		counters(id: string): CanvasNodeCounters {
			return snapshots.get(id) ?? EMPTY;
		},
		edgeCount(from: string, to: string): number {
			return edgeCounts.get(`${from}->${to}`) ?? 0;
		},
		pulses(): readonly ActivePulse[] {
			return pulses;
		},
		totals(): CanvasTotals {
			return totals;
		},
		subscribeNode(id: string, listener: () => void): () => void {
			let set = nodeListeners.get(id);
			if (!set) {
				set = new Set();
				nodeListeners.set(id, set);
			}
			set.add(listener);
			return () => set.delete(listener);
		},
		subscribe(listener: () => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** Apply pending changes now (tests, and a final flush on unmount). */
		flush,
	};
}

export type CanvasLiveStore = ReturnType<typeof createCanvasLiveStore>;
