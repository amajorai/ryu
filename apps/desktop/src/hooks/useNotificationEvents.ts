import { toast } from "@ryu/ui/components/sileo.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { getActiveUserId, useSession } from "@/lib/auth-client.ts";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { APPROVALS_ALIAS } from "@/src/contributions/companion-alias.ts";
import { useCompanionAlias } from "@/src/contributions/use-companion-alias.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	redactConnectSuggestionEvent,
	streamUserNotifications,
	type UserNotificationEvent,
} from "@/src/lib/api/notifications.ts";
import { showOsNotification } from "@/src/lib/notifications/os-notify.ts";
import { getUserAvailabilitySnapshot } from "@/src/lib/user-availability.ts";
import { useActiveNode } from "./useActiveNode.ts";

const RECONNECT_DELAY_MS = 2000;

/** Raise an OS notification (no-op when the user turned them off). When
 *  the ping carries a notification id, tapping it deep-links to the Inbox — but only
 *  if `onOpen` decides, at CLICK time, that some enabled app still owns that path;
 *  otherwise the click only focuses the window rather than opening a tab that can
 *  only say "App not enabled". Deciding at click time rather than at notify time
 *  matters in both directions: a ping that arrives before the contributions feed has
 *  loaded is still clickable once it lands, and a notification left on screen across
 *  an uninstall stops leading anywhere. */
function osNotify(event: UserNotificationEvent, onOpen: () => void): void {
	showOsNotification({
		title: event.title,
		body: event.body,
		tag: event.notification_id,
		onClick: () => {
			if (event.notification_id) {
				onOpen();
			}
		},
	}).catch(() => undefined);
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
	const userJwt = node.userJwt ?? null;
	const { data: session } = useSession();
	const meId = session?.user?.id ?? getActiveUserId() ?? null;
	const qc = useQueryClient();
	const { openTab } = useTabsContext();
	// The Inbox is an app surface (`@ryu/approvals`, not pre-installed), so the deep
	// link only exists while some enabled app claims the path. Held in a ref, not a
	// dependency: the contributions feed resolves after first paint and again on every
	// enable/disable, and tearing the notification stream down and reconnecting it
	// because a *click target* changed would drop pings for the reconnect window. The
	// ref is read inside the click handler, so an early ping is not frozen as
	// un-clickable just because the feed had not loaded when it arrived.
	const inboxOwner = useCompanionAlias(APPROVALS_ALIAS);
	const inboxOwnerRef = useRef(inboxOwner);
	inboxOwnerRef.current = inboxOwner;

	useEffect(() => {
		if (!meId) {
			return;
		}
		let cancelled = false;
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
		const controller = new AbortController();
		const target: ApiTarget = { url, token, userJwt };

		const onEvent = (event: UserNotificationEvent) => {
			const visibleEvent = redactConnectSuggestionEvent(
				event,
				getUserAvailabilitySnapshot().streamingPrivacyActive
			);
			const notify =
				visibleEvent.level === "error" || visibleEvent.level === "warning"
					? toast.error
					: toast.info;
			notify({
				title: visibleEvent.title,
				description: visibleEvent.body ?? undefined,
			});
			osNotify(visibleEvent, () => {
				if (inboxOwnerRef.current) {
					openTab("/inbox");
				}
			});
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
	}, [url, token, userJwt, meId, qc, openTab]);
}
