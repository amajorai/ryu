/**
 * One probe of the device-login state: `true` once the flow signed in, `false`
 * while it is still pending, or `{ failed }` when it ended without a sign-in.
 */
export type AccountProbeResult = boolean | { failed: string };

/** A view-owned observer of Core's device-login state, never the login itself. */
export function startAccountPolling(
	probe: (signal: AbortSignal) => Promise<AccountProbeResult>,
	/** `failure` is the flow's reason when it ended; absent on a timeout. */
	complete: (signedIn: boolean, failure?: string) => void,
	{ intervalMs, timeoutMs }: { intervalMs: number; timeoutMs: number }
): () => void {
	const controller = new AbortController();
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const stop = () => {
		if (stopped) {
			return;
		}
		stopped = true;
		clearTimeout(timer);
		clearTimeout(deadline);
		controller.abort();
	};
	const finish = (signedIn: boolean, failure?: string) => {
		if (stopped) {
			return;
		}
		stop();
		complete(signedIn, failure);
	};
	const deadline = setTimeout(() => finish(false), timeoutMs);
	const tick = async () => {
		if (stopped) {
			return;
		}
		const result = await probe(controller.signal).catch(() => false);
		if (stopped) {
			return;
		}
		if (result === true) {
			finish(true);
		} else if (result === false) {
			timer = setTimeout(tick, intervalMs);
		} else {
			finish(false, result.failed);
		}
	};
	timer = setTimeout(tick, intervalMs);
	return stop;
}
