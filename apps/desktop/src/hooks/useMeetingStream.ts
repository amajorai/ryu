import { useLiteralMessages } from "@ryu/i18n/react";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	listMeetings,
	type MeetingEvent,
	streamMeetingEvents,
} from "@/src/lib/api/meetings.ts";
import { useEnabledApps } from "@/src/lib/gating/useEnabledApps.ts";
import { useMeetingRecordingStore } from "@/src/store/useMeetingRecordingStore.ts";
import { useActiveNode } from "./useActiveNode.ts";

const INITIAL_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 10_000;

/**
 * Manifest id of the Meetings app (`apps-store/meetings`). Meetings runs
 * out-of-process, so its `/api/meetings/*` routes only exist on Core while the
 * app is enabled — see the gate in {@link useMeetingStream}.
 */
const MEETINGS_APP_ID = "@ryu/meetings";

/**
 * Subscribe to the Core meeting-event SSE stream for the active node. Auto-
 * detected meetings raise an info toast; transcript/status/finalize events
 * refresh the relevant queries so the Meetings page updates live. Auto-reconnects
 * on drop and re-subscribes when the active node changes. Mount once high in the
 * tree (e.g. the app shell).
 *
 * Gated on the Meetings app being ENABLED on the active node. Meetings is an
 * apps-store satellite serving `/api/meetings/*` off its sidecar's
 * `public_mount`, so while the app is off there is no mount and Core answers
 * 404 — not the 503 an in-crate `require_app_enabled` gate would give. Ungated,
 * the seed read and the reconnect loop made that a permanent 404 every couple of
 * seconds for as long as the window stayed open. `useEnabledApps`
 * returns `undefined` while the app list is unknown (first fetch in flight, Core
 * down) and this gate fails CLOSED on that — unlike the numeric caps, where
 * unknown must fail open. A stream that cannot connect anyway loses nothing by
 * waiting for the list, and the effect re-runs the moment it resolves.
 */
export function useMeetingStream(): void {
	const node = useActiveNode();
	const url = node.url;
	const token = node.token ?? null;
	const userJwt = node.userJwt ?? null;
	const qc = useQueryClient();
	const enabledApps = useEnabledApps();
	const meetingsEnabled = enabledApps?.has(MEETINGS_APP_ID) ?? false;
	const tl = useLiteralMessages();
	const tlRef = useRef(tl);
	tlRef.current = tl;

	useEffect(() => {
		// Gate INSIDE the effect: `if (x) useMeetingStream()` at the call site would
		// be a conditional hook, and it would skip the `reset()` cleanup below that
		// has to run when the app is disabled mid-session.
		if (!meetingsEnabled) {
			return;
		}

		let cancelled = false;
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
		const controller = new AbortController();
		const target: ApiTarget = { url, token, userJwt };
		const { applyEvent, seedFromMeetings, reset } =
			useMeetingRecordingStore.getState();

		listMeetings(target, controller.signal)
			.then((meetings) => {
				if (!cancelled) {
					seedFromMeetings(meetings);
				}
			})
			.catch(() => {
				// Best-effort seed; SSE events will catch up.
			});

		let backoff = INITIAL_RECONNECT_DELAY_MS;

		const onEvent = (event: MeetingEvent) => {
			// A live frame proves the sidecar is up: drop back to the fast retry.
			backoff = INITIAL_RECONNECT_DELAY_MS;
			applyEvent(event);
			switch (event.type) {
				case "detected":
					toast.info({
						title: "Meeting detected",
						description: tlRef.current(
							"{title} — open Meetings to start notes.",
							{ title: event.title }
						),
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
				// Exponential backoff: the app can be enabled while its sidecar is
				// still booting (or wedged), and a flat 2s retry made that a hot loop
				// for as long as the window stayed open.
				await new Promise<void>((resolve) => {
					reconnectTimer = setTimeout(resolve, backoff);
				});
				backoff = Math.min(backoff * 2, MAX_RECONNECT_DELAY_MS);
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
	}, [url, token, userJwt, qc, meetingsEnabled]);
}
