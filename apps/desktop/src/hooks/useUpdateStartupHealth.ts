import { useEffect, useState } from "react";
import { invokeWhenReady } from "../lib/tauri-ready.ts";
import { reportUpdateStartup } from "../lib/update-startup.ts";

export type UpdateStartupStatus = "checking" | "verifying" | "ready" | "failed";

export function useUpdateStartupHealth(
	enabled: boolean,
	active: boolean
): UpdateStartupStatus {
	const [status, setStatus] = useState<UpdateStartupStatus>(
		active ? "checking" : "ready"
	);
	useEffect(() => {
		if (!active) {
			return;
		}
		let mounted = true;
		void invokeWhenReady<boolean | null>("get_update_startup_health")
			.then((health) => {
				if (mounted) {
					setStatus(health === null ? "ready" : "verifying");
				}
			})
			.catch(() => {
				if (mounted) {
					setStatus("failed");
				}
			});
		return () => {
			mounted = false;
		};
	}, [active]);

	useEffect(() => {
		if (!(active && enabled) || status !== "verifying") {
			return;
		}
		const controller = new AbortController();
		void reportUpdateStartup({ signal: controller.signal })
			.then(() => {
				if (!controller.signal.aborted) {
					setStatus("ready");
				}
			})
			.catch(() => {
				if (!controller.signal.aborted) {
					setStatus("failed");
				}
			});
		return () => controller.abort();
	}, [active, enabled, status]);
	return status;
}
