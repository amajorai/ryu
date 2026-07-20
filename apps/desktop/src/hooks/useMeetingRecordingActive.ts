import { useMeetingRecordingStore } from "@/src/store/useMeetingRecordingStore.ts";

/** True while at least one meeting is actively recording on the active node. */
export function useMeetingRecordingActive(): boolean {
	return useMeetingRecordingStore((s) => s.active);
}
