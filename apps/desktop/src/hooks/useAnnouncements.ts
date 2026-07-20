// apps/desktop/src/hooks/useAnnouncements.ts
//
// Loads the caller's product-announcement feed from the control-plane server
// (lib/api/announcements.ts). Plain state + manual refresh rather than TanStack
// Query because this targets :3000 (session-authed) instead of the active Core
// node, so it sits outside the node-scoped query cache the other hooks share
// (same reasoning as useCreditsWallet / useChannels).
//
// Read/dismiss are optimistic: the local list updates immediately, then the POST
// persists server-side. A failed POST re-syncs from the server so the UI never
// drifts from the truth.

import { useCallback, useEffect, useState } from "react";
import {
	type Announcement,
	dismissAnnouncement,
	fetchAnnouncements,
	hasAnnouncementsAuth,
	markAnnouncementRead,
} from "@/src/lib/api/announcements.ts";
import { useCoreRefresh } from "@/src/lib/core-refresh.ts";

interface UseAnnouncements {
	announcements: Announcement[];
	/** False when there is no session token (the feed requires sign-in). */
	authed: boolean;
	dismiss: (id: string) => Promise<void>;
	loading: boolean;
	markRead: (id: string) => Promise<void>;
	refresh: () => Promise<void>;
	/** How many announcements the user hasn't read yet (for a badge). */
	unreadCount: number;
}

export function useAnnouncements(): UseAnnouncements {
	const [announcements, setAnnouncements] = useState<Announcement[]>([]);
	const [loading, setLoading] = useState(true);
	const authed = hasAnnouncementsAuth();

	const refresh = useCallback(async () => {
		if (!hasAnnouncementsAuth()) {
			setAnnouncements([]);
			setLoading(false);
			return;
		}
		setLoading(true);
		try {
			setAnnouncements(await fetchAnnouncements());
		} catch {
			// Announcements are non-critical chrome; a failed load just shows nothing.
			setAnnouncements([]);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		refresh().catch(() => undefined);
	}, [refresh]);

	// Auto-recover when Core reconnects or the user hits "Refresh all".
	useCoreRefresh(refresh);

	// Re-fetch on focus so an admin's newly-published announcement shows up when
	// the user returns to the app, without a manual reload.
	useEffect(() => {
		const onFocus = () => {
			refresh().catch(() => undefined);
		};
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [refresh]);

	const markRead = useCallback(async (id: string) => {
		setAnnouncements((prev) =>
			prev.map((a) => (a.id === id ? { ...a, read: true } : a))
		);
		try {
			await markAnnouncementRead(id);
		} catch {
			// Roll back to server truth on failure.
			await refreshFrom(setAnnouncements);
		}
	}, []);

	const dismiss = useCallback(async (id: string) => {
		setAnnouncements((prev) => prev.filter((a) => a.id !== id));
		try {
			await dismissAnnouncement(id);
		} catch {
			await refreshFrom(setAnnouncements);
		}
	}, []);

	const unreadCount = announcements.filter((a) => !a.read).length;

	return {
		announcements,
		authed,
		dismiss,
		loading,
		markRead,
		refresh,
		unreadCount,
	};
}

/** Re-pull the feed into state (used to roll back a failed optimistic write). */
async function refreshFrom(
	setAnnouncements: (a: Announcement[]) => void
): Promise<void> {
	try {
		setAnnouncements(await fetchAnnouncements());
	} catch {
		// Leave the optimistic state as-is if even the re-sync fails.
	}
}
