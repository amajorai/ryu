import { usePersistedToggle } from "@/src/hooks/usePersistedToggle.ts";

export const FOLLOW_UP_QUEUEING_KEY = "ryu.chat.queue_followups";

export function useFollowUpQueueing(): [boolean, (enabled: boolean) => void] {
	return usePersistedToggle(FOLLOW_UP_QUEUEING_KEY, true);
}
