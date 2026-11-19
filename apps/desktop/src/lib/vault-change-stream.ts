// Keeps the Desktop vault page current with Core's value-free change stream
// (`GET /api/vault/events`, `@ryuhq/core-client/vault-events`). Each change,
// or a notice that the subscriber fell behind, refreshes the vault queries
// once per burst, so edits made from the CLI, an agent, or another window
// show up without a manual reload. Events carry coordinates only, never a
// value. A dropped stream reconnects with capped backoff; a refusal (401,
// 403, 404) stops, since the caller cannot watch and retrying would not help.

import type { VaultEventMessage } from "@ryuhq/core-client/vault-events";

/** Opens one subscription; resolves once Core accepted it. */
export type OpenVaultStream = (
	signal: AbortSignal
) => Promise<AsyncIterable<VaultEventMessage>>;

export interface VaultChangeWatch {
	/** Reconnect delays in ms; the last one repeats. */
	backoffMs?: readonly number[];
	clearTimer?: (handle: unknown) => void;
	debounceMs?: number;
	/** Called at most once per `debounceMs` burst of changes. */
	onChange: () => void;
	open: OpenVaultStream;
	setTimer?: (fn: () => void, ms: number) => unknown;
	signal: AbortSignal;
	/** Injected for tests. */
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const DEFAULT_BACKOFF_MS = [1000, 2000, 5000, 15_000, 30_000];
const REFUSED = new Set([401, 403, 404]);

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}

/** Whether an error means this caller may not watch, so retrying is pointless. */
export function isRefusal(error: unknown): boolean {
	const status =
		typeof error === "object" && error !== null && "status" in error
			? error.status
			: undefined;
	return typeof status === "number" && REFUSED.has(status);
}

/**
 * Watches until `signal` aborts or Core refuses. Resolves with why it
 * stopped. The backoff resets after a stream that delivered anything.
 */
export async function watchVaultChanges(
	watch: VaultChangeWatch
): Promise<"aborted" | "refused"> {
	const {
		open,
		onChange,
		signal,
		debounceMs = 250,
		backoffMs = DEFAULT_BACKOFF_MS,
		sleep = abortableSleep,
		setTimer = (fn, ms) => setTimeout(fn, ms),
		clearTimer = (handle) =>
			clearTimeout(handle as ReturnType<typeof setTimeout>),
	} = watch;
	let pending: unknown = null;
	const schedule = () => {
		if (pending !== null) {
			return;
		}
		pending = setTimer(() => {
			pending = null;
			if (!signal.aborted) {
				onChange();
			}
		}, debounceMs);
	};
	let attempt = 0;
	try {
		while (!signal.aborted) {
			try {
				const stream = await open(signal);
				for await (const message of stream) {
					if (signal.aborted) {
						break;
					}
					attempt = 0;
					if (message.kind === "event" || message.kind === "lagged") {
						schedule();
					}
				}
			} catch (error) {
				if (signal.aborted) {
					break;
				}
				if (isRefusal(error)) {
					return "refused";
				}
			}
			if (signal.aborted) {
				break;
			}
			const delay =
				backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 30_000;
			attempt += 1;
			await sleep(delay, signal);
		}
		return "aborted";
	} finally {
		if (pending !== null) {
			clearTimer(pending);
		}
	}
}
