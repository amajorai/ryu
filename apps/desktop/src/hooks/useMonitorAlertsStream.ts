import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { sileo } from "sileo";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { type Alert, streamMonitorAlerts } from "@/src/lib/api/monitors.ts";
import { useActiveNode } from "./useActiveNode.ts";

const RECONNECT_DELAY_MS = 2000;

/** Raise a native OS notification (best-effort; requests permission once). */
function osNotify(alert: Alert): void {
	if (typeof Notification === "undefined") {
		return;
	}
	const show = () => {
		try {
			const n = new Notification(`${alert.monitor_name}: ${alert.title}`, {
				body: alert.message,
				tag: `monitor-${alert.monitor_id}`,
			});
			n.onclick = () => window.focus();
		} catch {
			// Notification construction can throw on some platforms; ignore.
		}
	};
	if (Notification.permission === "granted") {
		show();
	} else if (Notification.permission === "default") {
		Notification.requestPermission()
			.then((perm) => {
				if (perm === "granted") {
					show();
				}
			})
			.catch(() => undefined);
	}
}

/**
 * Subscribe to the Core monitor-alert SSE stream for the active node. Each alert
 * raises an in-app toast and a native OS notification, and refreshes the alert
 * queries. Auto-reconnects on drop and re-subscribes when the active node
 * changes. Mount once high in the tree (e.g. the app shell).
 */
export function useMonitorAlertsStream(): void {
	const node = useActiveNode();
	const url = node.url;
	const token = node.token ?? null;
	const qc = useQueryClient();

	useEffect(() => {
		let cancelled = false;
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
		const controller = new AbortController();
		const target: ApiTarget = { url, token };

		const onAlert = (alert: Alert) => {
			sileo.error({ title: alert.title, description: alert.message });
			osNotify(alert);
			Promise.resolve(qc.invalidateQueries({ queryKey: ["monitors"] })).catch(
				() => undefined
			);
		};

		const run = async () => {
			while (!cancelled) {
				try {
					await streamMonitorAlerts(target, onAlert, controller.signal);
				} catch {
					// Connect/transient failure — fall through to the reconnect delay.
				}
				if (cancelled) {
					break;
				}
				await new Promise<void>((resolve) => {
					reconnectTimer = setTimeout(resolve, RECONNECT_DELAY_MS);
				});
			}
		};
		run().catch(() => undefined);

		return () => {
			cancelled = true;
			controller.abort();
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
			}
		};
	}, [url, token, qc]);
}
