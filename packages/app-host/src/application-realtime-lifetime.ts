/** Discard late credentials/joins when the owning companion document closes. */
export function waitForApplicationRealtime<T>(
	value: Promise<T>,
	signal: AbortSignal
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(new Error("companion document is closed"));
		if (signal.aborted) {
			abort();
		} else {
			signal.addEventListener("abort", abort, { once: true });
		}
		// Attach both handlers even after cancellation so late rejection is consumed.
		value
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", abort));
	});
}
