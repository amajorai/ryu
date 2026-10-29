import { toast } from "@ryu/ui/components/sileo.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { type Alert, streamMonitorAlerts } from "@/src/lib/api/monitors.ts";
import { showOsNotification } from "@/src/lib/notifications/os-notify.ts";
import { useActiveNode } from "./useActiveNode.ts";

/** Raise an OS notification (no-op when the user turned them off). */
function osNotify(alert: Alert, isCurrent: () => boolean): void {
	if (!isCurrent()) {
		return;
	}
	showOsNotification({
		title: `${alert.monitor_name}: ${alert.title}`,
		body: alert.message,
		tag: `monitor-${alert.monitor_id}`,
	}).catch(() => undefined);
}

/**
 * Subscribe to the Core monitor-alert SSE stream for the active node. Each alert
 * raises an in-app toast and a native OS notification, and refreshes the alert
 * queries, as does every reconnect of the shared stream. Auto-reconnects on drop
 * and re-subscribes when the active node changes. Mount once high in the tree
 * (e.g. the app shell).
 */
export function useMonitorAlertsStream(): void {
	const node = useActiveNode();
	const url = node.url;
	const token = node.token ?? null;
	const userJwt = node.userJwt ?? null;
	const authority = useMemo(() => ({}), [url, token, userJwt]);
	const currentAuthority = useRef(authority);
	currentAuthority.current = authority;
	const qc = useQueryClient();

	useEffect(() => {
		const controller = new AbortController();
		const target: ApiTarget = { url, token, userJwt };

		const refreshMonitors = () => {
			Promise.resolve(qc.invalidateQueries({ queryKey: ["monitors"] })).catch(
				() => undefined
			);
		};

		const onAlert = (alert: Alert) => {
			toast.error({ title: alert.title, description: alert.message });
			osNotify(
				alert,
				() =>
					currentAuthority.current === authority && !controller.signal.aborted
			);
			refreshMonitors();
		};

		// The shared event multiplexer owns reconnect/backoff for this channel.
		// Alerts from while it was reconnecting are never replayed, so refetch
		// (without a toast) whenever it re-opens.
		streamMonitorAlerts(
			target,
			onAlert,
			controller.signal,
			refreshMonitors
		).catch(() => undefined);

		return () => {
			controller.abort();
		};
	}, [url, token, userJwt, authority, qc]);
}
