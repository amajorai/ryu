const POLL_INTERVAL_MS = 2000;
/** Give up waiting for a browser sign-in after this long. */
const CONNECT_TIMEOUT_MS = 10 * 60 * 1000;
const STATUS_REQUEST_TIMEOUT_MS = 15_000;

function abortError(): DOMException {
	return new DOMException("The connection was cancelled.", "AbortError");
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(abortError());
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			reject(abortError());
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Poll `check` until it reports done. `check` returns true when connected and
 * throws when the flow failed. Rejects on abort or after the timeout.
 */
export async function pollUntilConnected(
	check: () => Promise<boolean>,
	signal: AbortSignal,
	appName: string
): Promise<void> {
	const deadline = Date.now() + CONNECT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await wait(POLL_INTERVAL_MS, signal);
		// Each status request is bounded too: a stalled request must not hold
		// the card past the deadline or ignore "Stop waiting".
		const remaining = Math.max(0, deadline - Date.now());
		if (
			await boundedCheck(
				check,
				signal,
				Math.min(STATUS_REQUEST_TIMEOUT_MS, remaining)
			)
		) {
			return;
		}
	}
	throw new Error(
		`Timed out waiting for ${appName}. Try again when you're ready to sign in.`
	);
}

/** One status check that settles on abort or after `timeoutMs`, as "not yet". */
function boundedCheck(
	check: () => Promise<boolean>,
	signal: AbortSignal,
	timeoutMs: number
): Promise<boolean> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(abortError());
			return;
		}
		const timer = setTimeout(() => {
			cleanup();
			resolve(false);
		}, timeoutMs);
		function onAbort() {
			cleanup();
			reject(abortError());
		}
		function cleanup() {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		}
		signal.addEventListener("abort", onAbort, { once: true });
		check().then(
			(done) => {
				cleanup();
				resolve(done);
			},
			(error: unknown) => {
				cleanup();
				reject(error);
			}
		);
	});
}
