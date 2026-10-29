export type ApplicationRealtimePush =
	| { data: unknown; name: string; type: "event" }
	| { data: unknown; type: "presence" }
	| { dropped?: number; reason: string; type: "resync_required" }
	| { code: number; reason: string; type: "close" };

export const APPLICATION_REALTIME_QUEUE_LIMIT = 256;

const OVERFLOW_CLOSE: Extract<ApplicationRealtimePush, { type: "close" }> = {
	code: 1013,
	reason: "realtime consumer fell behind",
	type: "close",
};

interface PendingTake {
	onAbort: () => void;
	resolve: (value: ApplicationRealtimePush | null) => void;
}

/**
 * A bounded single-consumer queue between the trusted realtime client and a
 * sandboxed companion. Presence is a replaceable snapshot, while named events
 * remain ordered. If a companion stops consuming, overflow closes the stream
 * instead of retaining attacker-controlled payloads without limit.
 */
export class ApplicationRealtimeQueue {
	private closed = false;
	private readonly pending: PendingTake[] = [];
	private readonly values: ApplicationRealtimePush[] = [];

	constructor(
		private readonly limit: number = APPLICATION_REALTIME_QUEUE_LIMIT
	) {
		if (!(Number.isInteger(limit) && limit > 0)) {
			throw new Error("realtime queue limit must be a positive integer");
		}
	}

	/** Returns false when this push overflowed and closed the queue. */
	push(value: Exclude<ApplicationRealtimePush, { type: "close" }>): boolean {
		if (this.closed) {
			return false;
		}
		const waiter = this.pending.shift();
		if (waiter) {
			waiter.resolve(value);
			return true;
		}

		if (value.type === "presence") {
			for (let index = this.values.length - 1; index >= 0; index -= 1) {
				if (this.values[index]?.type === "presence") {
					this.values.splice(index, 1);
					break;
				}
			}
		}

		if (this.values.length >= this.limit) {
			this.close(OVERFLOW_CLOSE, true);
			return false;
		}
		this.values.push(value);
		return true;
	}

	/** Close the stream while ensuring the terminal signal is observable. */
	close(
		value: Extract<ApplicationRealtimePush, { type: "close" }>,
		discardQueued = false
	): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		if (discardQueued) {
			this.values.splice(0);
		}

		const waiter = this.pending.shift();
		if (waiter) {
			waiter.resolve(value);
		} else {
			if (this.values.length >= this.limit) {
				this.values.pop();
			}
			this.values.push(value);
		}
		for (const extraWaiter of this.pending.splice(0)) {
			extraWaiter.resolve(null);
		}
	}

	end(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		for (const waiter of this.pending.splice(0)) {
			waiter.resolve(null);
		}
	}

	take(signal: AbortSignal): Promise<ApplicationRealtimePush | null> {
		if (this.values.length > 0) {
			return Promise.resolve(this.values.shift() ?? null);
		}
		if (this.closed || signal.aborted) {
			return Promise.resolve(null);
		}
		return new Promise((resolve) => {
			const waiter: PendingTake = {
				onAbort: () => {
					const index = this.pending.indexOf(waiter);
					if (index >= 0) {
						this.pending.splice(index, 1);
					}
					resolve(null);
				},
				resolve: (value) => {
					signal.removeEventListener("abort", waiter.onAbort);
					resolve(value);
				},
			};
			this.pending.push(waiter);
			signal.addEventListener("abort", waiter.onAbort, { once: true });
		});
	}
}
