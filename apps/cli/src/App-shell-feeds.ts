// The shell's background feeds: the launch update notice, the CLI self-update
// and the per-user notification stream. Split out of App.tsx.

import type { ApiTarget } from "@ryuhq/core-client/client";
import { useEffect, useRef } from "react";
import { fetchActiveAccountIdentity } from "./core/humanMentions.ts";
import { startCliAutoUpdate } from "./core/self-update.ts";
import { fetchUpdateCheck } from "./core/update.ts";
import { streamUserNotifications } from "./core/userNotificationStream.ts";
import { tf } from "./i18n/translate.ts";
import type { useToast } from "./ui/toast.tsx";

type Notify = ReturnType<typeof useToast>["notify"];

export function useLaunchUpdateNotice(target: ApiTarget, notify: Notify) {
	// Launch update notice, the port of apps/cli's on-launch fetch_update_check.
	// Runs on mount and on every node switch (target changes), flashing a toast
	// when the node reports a newer Ryu release. Errors resolve to null in the
	// reader, so this never blocks the shell.
	useEffect(() => {
		let cancelled = false;
		fetchUpdateCheck(target)
			.then((notice) => {
				if (!cancelled && notice?.available) {
					notify(
						tf("▲ Core {latest} is available (node {current})", {
							current: notice.current,
							latest: notice.latest,
						}),
						"info"
					);
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [target, notify]);
}

export function useCliAutoUpdate(target: ApiTarget, notify: Notify) {
	const autoUpdateStarted = useRef(false);
	// Download and verify the matching CLI release without delaying or interrupting
	// the terminal session. The replacement takes effect the next time ryu-cli runs.
	useEffect(() => {
		if (autoUpdateStarted.current) {
			return;
		}
		autoUpdateStarted.current = true;
		let cancelled = false;
		void startCliAutoUpdate(target)
			.then((result) => {
				if (cancelled) {
					return;
				}
				if (result.status === "installed") {
					notify(
						tf("Ryu CLI {version} is ready and will run on your next launch.", {
							version: result.version,
						}),
						"success"
					);
				} else if (result.status === "pending-exit") {
					notify(
						tf("Ryu CLI {version} will install after this session closes.", {
							version: result.version,
						}),
						"success"
					);
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [target, notify]);
}

export function useUserNotificationFeed(
	target: ApiTarget,
	authSourceTarget: ApiTarget,
	notify: Notify
) {
	// Match Desktop's per-user notification feed. Core performs recipient filtering;
	// the local account id is included for local nodes that have no verified caller.
	useEffect(() => {
		let cancelled = false;
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
		const controller = new AbortController();
		const run = async (userId: string | null) => {
			const seenNotificationIds = new Set<string>();
			const onEvent = (event: {
				body?: string | null;
				level?: string;
				notification_id?: string | null;
				target_user_id?: string | null;
				title: string;
			}) => {
				if (event.target_user_id && userId && event.target_user_id !== userId) {
					return;
				}
				const notificationId = event.notification_id;
				if (notificationId && seenNotificationIds.has(notificationId)) {
					return;
				}
				if (notificationId) {
					seenNotificationIds.add(notificationId);
					if (seenNotificationIds.size > 128) {
						const oldest = seenNotificationIds.values().next().value;
						if (oldest) {
							seenNotificationIds.delete(oldest);
						}
					}
				}
				const variant =
					event.level === "error" || event.level === "warning"
						? "error"
						: "info";
				const message = event.body
					? `${event.title} · ${event.body}`
					: event.title;
				notify(message, variant);
			};
			while (!cancelled) {
				try {
					await streamUserNotifications(
						target,
						userId,
						onEvent,
						controller.signal
					);
				} catch {
					// Connection failures are transient; reconnect without spamming the TUI.
				}
				if (cancelled) {
					break;
				}
				await new Promise<void>((resolve) => {
					reconnectTimer = setTimeout(resolve, 2000);
				});
			}
		};
		const start = async () => {
			const identityTarget = target.userJwt ? target : authSourceTarget;
			const identity = await fetchActiveAccountIdentity(identityTarget);
			if (cancelled || !(identity || target.userJwt)) {
				return;
			}
			const userId = identity?.userId ?? null;
			await run(userId);
		};
		void start().catch(() => undefined);
		return () => {
			cancelled = true;
			controller.abort();
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
			}
		};
	}, [authSourceTarget, notify, target]);
}
