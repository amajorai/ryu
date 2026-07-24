import { toast } from "@ryu/ui/components/sileo";
import { useEffect } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type DesktopNotification,
	streamDesktopNotifications,
} from "@/src/lib/api/events.ts";
import { useActiveNode } from "./useActiveNode.ts";

const RECONNECT_DELAY_MS = 2000;

/** Raise a native OS notification (best-effort; requests permission once). */
function osNotify(n: DesktopNotification): void {
	if (typeof Notification === "undefined") {
		return;
	}
	const show = () => {
		try {
			const notification = new Notification(n.title, {
				body: n.body ?? undefined,
			});
			notification.onclick = () => window.focus();
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
 * Subscribe to Core's desktop-notification SSE stream for the active node. Each
 * notification (pushed by a built-in agent action like `notify__desktop`) raises
 * an in-app toast and a native OS notification. Auto-reconnects on drop and
 * re-subscribes when the active node changes. Mount once high in the tree.
 */
export function useDesktopNotificationsStream(): void {
	const node = useActiveNode();
	const url = node.url;
	const token = node.token ?? null;

	useEffect(() => {
		let cancelled = false;
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
		const controller = new AbortController();
		const target: ApiTarget = { url, token };

		const onNotification = (n: DesktopNotification) => {
			const notify =
				n.level === "error" || n.level === "warning"
					? toast.error
					: toast.success;
			notify({ title: n.title, description: n.body ?? undefined });
			osNotify(n);
		};

		const run = async () => {
			while (!cancelled) {
				try {
					await streamDesktopNotifications(
						target,
						onNotification,
						controller.signal
					);
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
	}, [url, token]);
}
