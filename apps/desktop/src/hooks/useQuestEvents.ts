import { useLiteralMessages } from "@ryu/i18n/react";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { type QuestEvent, streamQuestEvents } from "@/src/lib/api/quests.ts";
import { showOsNotification } from "@/src/lib/notifications/os-notify.ts";
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
			if (event.type === "suggested") {
				toast.info({
					title: tlRef.current("Looks done: {title}", {
						title: event.quest.title,
					}),
					description: event.reason,
				});
				osNotify(
					`Finished "${event.quest.title}"?`,
					event.reason,
					`quest-${event.quest.id}`,
					() =>
						currentAuthority.current === authority && !controller.signal.aborted
				);
			} else if (event.type === "completed" && event.auto) {
				toast.success({
					title: `Auto-completed: ${event.quest.title}`,
					description:
						event.quest.suggestion?.reason ?? "Detected from your activity.",
				});
				osNotify(
					`Done: ${event.quest.title}`,
					"Ryu detected this task as finished.",
					`quest-${event.quest.id}`,
					() =>
						currentAuthority.current === authority && !controller.signal.aborted
				);
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
