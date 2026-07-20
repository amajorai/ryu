// apps/desktop/src/hooks/useChannelStatus.ts
//
// Live per-channel connection state (Telegram/Slack/… bots), keyed by channel
// id. Backed by the shared reconnecting socket in lib/api/channelStatus.ts, so
// mounting this hook in several places still opens only one stream.

import { useEffect, useState } from "react";
import {
	type ChannelLiveState,
	subscribeChannelStatus,
} from "@/src/lib/api/channelStatus.ts";

export function useChannelStatus(): Map<string, ChannelLiveState> {
	const [statuses, setStatuses] = useState<Map<string, ChannelLiveState>>(
		() => new Map()
	);

	useEffect(() => subscribeChannelStatus(setStatuses), []);

	return statuses;
}
