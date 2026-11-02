import { useLiteralMessages } from "@ryu/i18n/react";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { type QuestEvent, streamQuestEvents } from "@/src/lib/api/quests.ts";
import { showOsNotification } from "@/src/lib/notifications/os-notify.ts";
import { playSound } from "@/src/lib/sounds/play-sound.ts";
import { useActiveNode } from "./useActiveNode.ts";

/** Raise an OS notification (no-op when the user turned them off). */
function osNotify(
	title: string,
	body: string,
	tag: string,
	isCurrent: () => boolean
): void {
	if (!isCurrent()) {
		return;
	}
	showOsNotification({ title, body, tag }).catch(() => undefined);
}

/**
 * Subscribe to the Core quest-event SSE stream for the active node. A detection
 * suggestion raises an in-app toast and a native OS notification; an
 * auto-completion announces itself. Every event refreshes the quest queries, as
 * does every reconnect of the shared stream. Auto-reconnects on drop and
 * re-subscribes when the active node changes. Mount once high in the tree (the
 * app shell).
 */
export function useQuestEvents(): void {
	const node = useActiveNode();
	const url = node.url;
	const token = node.token ?? null;
	const userJwt = node.userJwt ?? null;
	const authority = useMemo(() => ({}), [url, token, userJwt]);
	const currentAuthority = useRef(authority);
	currentAuthority.current = authority;
	const qc = useQueryClient();
	const tl = useLiteralMessages();
	const tlRef = useRef(tl);
	tlRef.current = tl;

	useEffect(() => {
		const controller = new AbortController();
		const target: ApiTarget = { url, token, userJwt };

		const refreshQuests = () => {
			Promise.resolve(qc.invalidateQueries({ queryKey: ["quests"] })).catch(
				() => undefined
			);
		};

		const onEvent = (event: QuestEvent) => {
			// OS banners never reach the DOM localizer, and `localizeNativeCopy`
			// matches whole literals only, so every interpolated string is
			// translated here before it leaves the webview.
			const tl = tlRef.current;
			const title = event.type === "deleted" ? "" : event.quest.title;
			const isCurrent = () =>
				currentAuthority.current === authority && !controller.signal.aborted;
			if (event.type === "suggested") {
				toast.info({
					title: tl("Looks done: {title}", { title }),
					description: event.reason,
				});
				playSound("quest-suggest", {
					key: `quest-suggest:${event.quest.id}`,
					source: "stream",
				});
				osNotify(
					tl("Finished “{title}”?", { title }),
					event.reason,
					`quest-${event.quest.id}`,
					isCurrent
				);
			} else if (event.type === "completed" && event.auto) {
				toast.success({
					title: tl("Auto-completed: {title}", { title }),
					description:
						event.quest.suggestion?.reason ??
						tl("Detected from your activity."),
				});
				playSound("quest-complete", {
					key: `quest:${event.quest.id}`,
					source: "stream",
				});
				osNotify(
					tl("Done: {title}", { title }),
					tl("Ryu detected this task as finished."),
					`quest-${event.quest.id}`,
					isCurrent
				);
			} else if (event.type === "completed") {
				// A manual completion (Inbox accept, the quests app) has no toast,
				// but the reward cue still lands. The stream is the one source, so
				// the mutation's onSuccess must not play it too.
				playSound("quest-complete", {
					key: `quest:${event.quest.id}`,
					source: "stream",
				});
			}
			refreshQuests();
		};

		// The shared event multiplexer owns reconnect/backoff for this channel.
		// Events from while it was reconnecting are never replayed, so refetch
		// (without a toast) whenever it re-opens.
		streamQuestEvents(target, onEvent, controller.signal, refreshQuests).catch(
			() => undefined
		);

		return () => {
			controller.abort();
		};
	}, [url, token, userJwt, authority, qc]);
}
