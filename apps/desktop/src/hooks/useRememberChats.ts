// apps/desktop/src/hooks/useRememberChats.ts
//
// The node's "Remember chats" opt-in (`chat-memory-enabled`): whether Core may
// index chat messages for transcript search and Dream review. Off by default.
// Every mounted control follows a save made by any other one, so the Dream
// switch and its "turn on" prompt never disagree.

import { useCallback, useEffect, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	CHAT_MEMORY_ENABLED_PREF_KEY,
	getChatMemoryEnabled,
	setChatMemoryEnabled,
	subscribePreferenceChanges,
} from "@/src/lib/api/preferences.ts";

export type RememberChatsError = "load" | "save";

export interface RememberChatsState {
	/** The saved value; null until it has loaded. */
	enabled: boolean | null;
	error: RememberChatsError | null;
	loading: boolean;
	/**
	 * Reads the saved value again, for when Core may have seen a change this
	 * window did not (another window or client). Resolves the value read, or
	 * null when the read failed.
	 */
	reload: () => Promise<boolean | null>;
	saving: boolean;
	/** Saves the opt-in. Resolves false (and keeps the old value) on failure. */
	setEnabled: (next: boolean) => Promise<boolean>;
}

export function useRememberChats(target: ApiTarget): RememberChatsState {
	const [enabled, setEnabledState] = useState<boolean | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<RememberChatsError | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		getChatMemoryEnabled(target)
			.then((value) => {
				if (!cancelled) {
					setEnabledState(value);
					setError(null);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setError("load");
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [target]);

	useEffect(
		() =>
			subscribePreferenceChanges((key, value) => {
				if (key === CHAT_MEMORY_ENABLED_PREF_KEY) {
					setEnabledState(value === "true");
					setError(null);
				}
			}),
		[]
	);

	const reload = useCallback(async () => {
		try {
			const value = await getChatMemoryEnabled(target);
			setEnabledState(value);
			setError(null);
			return value;
		} catch {
			setError("load");
			return null;
		}
	}, [target]);

	const setEnabled = useCallback(
		async (next: boolean) => {
			setSaving(true);
			setError(null);
			try {
				await setChatMemoryEnabled(target, next);
				setEnabledState(next);
				return true;
			} catch {
				setError("save");
				return false;
			} finally {
				setSaving(false);
			}
		},
		[target]
	);

	return { enabled, error, loading, reload, saving, setEnabled };
}
