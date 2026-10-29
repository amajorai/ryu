// packages/services/src/tools/collect.ts
//
// `collectEvents(iterable, { maxEvents, timeoutMs })`: drains a stream inside
// one tool call, so a streaming tool (Managed Agents `list_events` with
// `wait: true`) never runs unbounded.

/** Bounds for draining a stream inside one tool call. */
export interface CollectOptions {
	/** Stop after this many items. */
	readonly maxEvents: number;
	readonly signal?: AbortSignal;
	/** Stop waiting after this long, in ms. */
	readonly timeoutMs: number;
}

/** What {@link collectEvents} gathered. */
export interface CollectedEvents<T> {
	/** Present (true) only when `signal` fired first: the host cancelled. */
	readonly aborted?: true;
	/** The stream ended on its own (never true when aborted). */
	readonly done: boolean;
	readonly events: T[];
	/** The time bound elapsed first. */
	readonly timedOut: boolean;
}

/**
 * Drains an async iterable until it ends, `maxEvents` items arrive, or
 * `timeoutMs` passes, then closes it.
 */
export async function collectEvents<T>(
	iterable: AsyncIterable<T>,
	options: CollectOptions
): Promise<CollectedEvents<T>> {
	const events: T[] = [];
	const iterator = iterable[Symbol.asyncIterator]();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), options.timeoutMs);
	});
	const { signal } = options;
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<"aborted">((resolve) => {
		onAbort = () => resolve("aborted");
		signal?.addEventListener("abort", onAbort, { once: true });
	});
	let done = false;
	let timedOut = false;
	try {
		while (events.length < options.maxEvents && !signal?.aborted) {
			const step = await Promise.race([iterator.next(), timeout, aborted]);
			if (step === "timeout") {
				timedOut = true;
				break;
			}
			if (step === "aborted" || signal?.aborted) {
				break;
			}
			if (step.done) {
				done = true;
				break;
			}
			events.push(step.value);
		}
	} finally {
		clearTimeout(timer);
		if (onAbort !== undefined) {
			signal?.removeEventListener("abort", onAbort);
		}
		if (!done) {
			Promise.resolve(iterator.return?.()).catch(() => undefined);
		}
	}
	return {
		events,
		done,
		timedOut,
		...(signal?.aborted === true ? { aborted: true as const } : {}),
	};
}
