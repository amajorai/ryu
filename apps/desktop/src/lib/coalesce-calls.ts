/**
 * Collapse overlapping calls to an async task: while one run is in flight,
 * further calls only mark that another run is needed, and exactly one more run
 * starts after it settles. A burst of N calls therefore costs at most two runs,
 * and the last run always starts after the most recent call, so it sees every
 * change that triggered one.
 */
export function coalesceCalls<TResult>(
	run: () => Promise<TResult>
): () => void {
	let inFlight = false;
	let queued = false;
	const trigger = () => {
		if (inFlight) {
			queued = true;
			return;
		}
		inFlight = true;
		run()
			.catch(() => undefined)
			.finally(() => {
				inFlight = false;
				if (queued) {
					queued = false;
					trigger();
				}
			});
	};
	return trigger;
}
