// apps/desktop/src/hooks/useChannels.ts
//
// Loads and mutates channel-bot configs from the control-plane server
// (lib/api/channels.ts). Plain state + manual refresh rather than TanStack Query
// because this targets :3000 (session-authed) instead of the active Core node,
// so it sits outside the node-scoped query cache the other hooks share.

import { useCallback, useEffect, useState } from "react";
import {
	type ChannelConfig,
	type ChannelInput,
	createChannel,
	deleteChannel,
	hasChannelAuth,
	listChannels,
	updateChannel,
} from "@/src/lib/api/channels.ts";

interface UseChannels {
	/** False when there is no session token (CRUD requires sign-in). */
	authed: boolean;
	channels: ChannelConfig[];
	create: (input: ChannelInput) => Promise<ChannelConfig>;
	error: string | null;
	loading: boolean;
	refresh: () => Promise<void>;
	remove: (id: string) => Promise<void>;
	update: (id: string, input: Partial<ChannelInput>) => Promise<ChannelConfig>;
}

export function useChannels(): UseChannels {
	const [channels, setChannels] = useState<ChannelConfig[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const authed = hasChannelAuth();

	const refresh = useCallback(async () => {
		if (!hasChannelAuth()) {
			setChannels([]);
			setLoading(false);
			setError(null);
			return;
		}
		setLoading(true);
		try {
			setChannels(await listChannels());
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not load channels.");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		refresh().catch(() => undefined);
	}, [refresh]);

	const create = useCallback(
		async (input: ChannelInput) => {
			const created = await createChannel(input);
			await refresh();
			return created;
		},
		[refresh]
	);

	const update = useCallback(
		async (id: string, input: Partial<ChannelInput>) => {
			const updated = await updateChannel(id, input);
			await refresh();
			return updated;
		},
		[refresh]
	);

	const remove = useCallback(
		async (id: string) => {
			await deleteChannel(id);
			await refresh();
		},
		[refresh]
	);

	return { channels, loading, error, authed, refresh, create, update, remove };
}
