// The per-frame in-flight call budget `ExtensionHost` applies to every valid
// unary and streaming request, so one app cannot turn a valid grant into
// unbounded promise/service work.

export const MAX_IN_FLIGHT_CALLS = 32;

export interface CallBudget {
	releaseCall(): void;
	tryAcquireCall(): boolean;
}

export function createCallBudget(limit = MAX_IN_FLIGHT_CALLS): CallBudget {
	let inFlight = 0;
	return {
		tryAcquireCall() {
			if (inFlight >= limit) {
				return false;
			}
			inFlight += 1;
			return true;
		},
		releaseCall() {
			inFlight = Math.max(0, inFlight - 1);
		},
	};
}
