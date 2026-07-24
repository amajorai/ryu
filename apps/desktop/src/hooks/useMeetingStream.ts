import { toast } from "@ryu/ui/components/sileo";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	listMeetings,
	type MeetingEvent,
	streamMeetingEvents,
} from "@/src/lib/api/meetings.ts";
import { useMeetingRecordingStore } from "@/src/store/useMeetingRecordingStore.ts";
import { useActiveNode } from "./useActiveNode.ts";

const RECONNECT_DELAY_MS = 2000;

/**
 * Subscribe to the Core meeting-event SSE stream for the active node. Auto-
 * detected meetings raise an info toast; transcript/status/finalize events
 * refresh the relevant queries so the Meetings page updates live. Auto-reconnects
 * on drop and re-subscribes when the active node changes. Mount once high in the
 * tree (e.g. the app shell).
 */
export function useMeetingStream(): void {
	const node = useActiveNode();
	const url = node.url;
	const token = node.token ?? null;
	const qc = useQueryClient();

	useEffect(() => {
		let cancelled = false;
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
		const controller = new AbortController();
		const target: ApiTarget = { url, token };
		const { applyEvent, seedFromMeetings, reset } =
			useMeetingRecordingStore.getState();

		listMeetings(target)
			.then((meetings) => {
				if (!cancelled) {
					seedFromMeetings(meetings);
				}
			})
			.catch(() => {
				// Best-effort seed; SSE events will catch up.
			});

		const onEvent = (event: MeetingEvent) => {
			applyEvent(event);
			switch (event.type) {
				case "detected":
					toast.info({
						title: "Meeting detected",
						description: `${event.title} — open Meetings to start notes.`,
					});
					break;
				case "segment":
					Promise.resolve(
						qc.invalidateQueries({
							queryKey: ["meetings", "transcript", event.segment.meeting_id],
						})
					).catch(() => undefined);
					break;
				case "started":
				case "finalized":
					Promise.resolve(
						qc.invalidateQueries({ queryKey: ["meetings"] })
					).catch(() => undefined);
					break;
				case "status":
					Promise.resolve(
						qc.invalidateQueries({ queryKey: ["meetings"] })
					).catch(() => undefined);
					break;
				default:
					break;
			}
		};

		const run = async () => {
			while (!cancelled) {
				try {
					await streamMeetingEvents(target, onEvent, controller.signal);
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
			reset();
		};
	}, [url, token, qc]);
}
