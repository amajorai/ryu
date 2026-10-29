import { toast } from "@ryu/ui/components/sileo.tsx";
import { useEffect, useMemo, useRef } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type DesktopNotification,
	streamDesktopNotifications,
} from "@/src/lib/api/events.ts";
import { showOsNotification } from "@/src/lib/notifications/os-notify.ts";
import { useActiveNode } from "./useActiveNode.ts";

/** Raise an OS notification (no-op when the user turned them off). */
function osNotify(n: DesktopNotification, isCurrent: () => boolean): void {
	if (!isCurrent()) {
		return;
	}
	showOsNotification({ title: n.title, body: n.body }).catch(() => undefined);
}

/**
 * Subscribe to Core's desktop-notification SSE stream for the active node. Each
 * notification (pushed by a built-in agent action like `notify.desktop`) raises
 * an in-app toast and a native OS notification. Auto-reconnects on drop and
 * re-subscribes when the active node changes. Mount once high in the tree.
 */
export function useDesktopNotificationsStream(): void {
	const node = useActiveNode();
	const url = node.url;
	const token = node.token ?? null;
	const userJwt = node.userJwt ?? null;
	const authority = useMemo(() => ({}), [url, token, userJwt]);
	const currentAuthority = useRef(authority);
	currentAuthority.current = authority;

	useEffect(() => {
		const controller = new AbortController();
		const target: ApiTarget = { url, token, userJwt };

		const onNotification = (n: DesktopNotification) => {
			const notify =
				n.level === "error" || n.level === "warning"
					? toast.error
					: toast.success;
			notify({ title: n.title, description: n.body ?? undefined });
			osNotify(
				n,
				() =>
					currentAuthority.current === authority && !controller.signal.aborted
			);
		};

		// The shared event multiplexer owns reconnect/backoff for this channel.
		streamDesktopNotifications(target, onNotification, controller.signal).catch(
			() => undefined
		);

		return () => {
			controller.abort();
		};
	}, [url, token, userJwt, authority]);
}
