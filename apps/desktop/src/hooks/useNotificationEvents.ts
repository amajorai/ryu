import { toast } from "@ryu/ui/components/sileo";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { getActiveUserId, useSession } from "@/lib/auth-client.ts";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	streamUserNotifications,
	type UserNotificationEvent,
} from "@/src/lib/api/notifications.ts";
import { useActiveNode } from "./useActiveNode.ts";

const RECONNECT_DELAY_MS = 2000;

/** Raise a native OS notification (best-effort; requests permission once). When
 *  the ping carries a notification id, tapping it deep-links to the Inbox. */
function osNotify(event: UserNotificationEvent, onOpen: () => void): void {
	if (typeof Notification === "undefined") {
		return;
	}
	const show = () => {
		try {
			const n = new Notification(event.title, {
				body: event.body ?? undefined,
				tag: event.notification_id ?? undefined,
			});
			n.onclick = () => {
				window.focus();
				if (event.notification_id) {
					onOpen();
				}
			};
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
 * Subscribe to Core's per-user notification SSE stream for the active node. Each
 * user-targeted ping (from a `notify_user` workflow node) raises an in-app toast
 * and a native OS notification, and refreshes the notifications feed so the Inbox
 * stays live. Tapping an OS notification with an id opens the Inbox.
 *
 * This is the surface for USER-TARGETED toasts: the broadcast
 * `useDesktopNotificationsStream` rides the multiplexed `/api/events/all`
 * `notifications` channel, which Core filters so per-user pings never arrive
 * there — so the two never double-toast. Auto-reconnects on drop and
 * re-subscribes when the active node or signed-in user changes. Mount once high
 * in the tree (the app shell).
 */
export function useNotificationEvents(): void {
	const node = useActiveNode();
	const url = node.url;
	const token = node.token ?? null;
	const { data: session } = useSession();
	const meId = session?.user?.id ?? getActiveUserId() ?? null;
	const qc = useQueryClient();
	const { openTab } = useTabsContext();

	useEffect(() => {
		if (!meId) {
			return;
		}
		let cancelled = false;
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
		const controller = new AbortController();
		const target: ApiTarget = { url, token };

		const onEvent = (event: UserNotificationEvent) => {
			const notify =
				event.level === "error" || event.level === "warning"
					? toast.error
					: toast.info;
			notify({ title: event.title, description: event.body ?? undefined });
			osNotify(event, () => openTab("/inbox"));
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["notifications"] })
			).catch(() => undefined);
		};

		const run = async () => {
			while (!cancelled) {
				try {
					await streamUserNotifications(
						target,
						meId,
						onEvent,
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
	}, [url, token, meId, qc, openTab]);
}
