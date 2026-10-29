import { useEffect } from "react";
import { getRyuStatus, startRyuCore } from "@/lib/tauri-bridge.ts";
import { useAppStore } from "../store/useAppStore.ts";

/** Starts Core and keeps `coreStatus` current for as long as the app is open.
 *  The Bot product has no local Core. */
export function useCoreStatusPoll(botProduct: boolean): void {
	const setCoreStatus = useAppStore((state) => state.setCoreStatus);

	useEffect(() => {
		if (botProduct) {
			return;
		}
		let cancelled = false;

		async function init() {
			// Attempt to spawn Core — ignore errors (may already be running).
			await startRyuCore().catch(() => undefined);

			// Poll the health check for as long as the app is open, rather than
			// giving up at the first verdict. `coreStatus` used to latch: the loop
			// returned on its first "running" or on the timeout, so a Core that came
			// up LATER — which is now the normal case, since onboarding's "run
			// locally" pick is what installs and starts it — left the store stuck on
			// "stopped" and stranded the user on Preflight next render.
			//
			// The grace window only decides when a still-absent Core is reported as
			// "stopped" rather than "starting"; it's long to accommodate first-time
			// Rust compilation in dev.
			const POLL_INTERVAL_MS = 1500;
			const IDLE_POLL_INTERVAL_MS = 5000;
			const GRACE_MS = 180_000;
			const start = Date.now();

			while (!cancelled) {
				const status = await getRyuStatus().catch(() => "stopped");
				if (cancelled) {
					return;
				}
				const settled = Date.now() - start > GRACE_MS;
				if (status === "running") {
					setCoreStatus("running");
				} else if (settled) {
					setCoreStatus("stopped");
				}
				await new Promise((r) =>
					setTimeout(
						r,
						status === "running" || settled
							? IDLE_POLL_INTERVAL_MS
							: POLL_INTERVAL_MS
					)
				);
			}
		}

		init();
		return () => {
			cancelled = true;
		};
	}, [botProduct, setCoreStatus]);
}
