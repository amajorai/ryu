import { recordQuestEvent } from "@ryuhq/core-client/quest-events.ts";
import { useEffect, useRef } from "react";
import { BACKEND_URL, getActiveToken } from "@/lib/auth-client.ts";
import type { AppSurface } from "@/src/contexts/app-surface-context.tsx";

/** Reports the once-per-session quest events for this surface. */
export function useQuestEvents({
	authed,
	hostSurface,
	userId,
	vaultReady,
}: {
	authed: boolean;
	hostSurface: AppSurface;
	userId: string | undefined;
	vaultReady: boolean;
}): void {
	const reportedQuestEventKeys = useRef(new Set<string>());
	// Quest events accept only the protocol's QUEST_EVENT_SURFACES; the web and
	// Telegram hosts do not report them.
	const questSurface =
		hostSurface === "web" || hostSurface === "telegram" ? null : hostSurface;

	useEffect(() => {
		if (!(authed && vaultReady && questSurface)) {
			return;
		}
		const token = getActiveToken();
		if (!token) {
			return;
		}
		const eventKey = `${questSurface}:${userId ?? "active-session"}`;
		if (reportedQuestEventKeys.current.has(eventKey)) {
			return;
		}
		reportedQuestEventKeys.current.add(eventKey);
		const target = { token, url: BACKEND_URL };
		const events = [
			recordQuestEvent(target, "referral_sync", questSurface),
			...(questSurface === "desktop"
				? [recordQuestEvent(target, "desktop_app_opened", questSurface)]
				: []),
		];
		void Promise.allSettled(events);
	}, [authed, questSurface, userId, vaultReady]);
}
