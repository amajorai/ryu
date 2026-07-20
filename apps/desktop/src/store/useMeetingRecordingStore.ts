import { create } from "zustand";
import type { Meeting, MeetingEvent } from "@/src/lib/api/meetings.ts";

function isRecordingStatus(status: string): boolean {
	return status === "recording";
}

function recordingIdsFromMeetings(meetings: Meeting[]): Set<string> {
	const ids = new Set<string>();
	for (const meeting of meetings) {
		if (isRecordingStatus(meeting.status)) {
			ids.add(meeting.id);
		}
	}
	return ids;
}

interface MeetingRecordingStore {
	active: boolean;
	applyEvent: (event: MeetingEvent) => void;
	recordingIds: Set<string>;
	reset: () => void;
	seedFromMeetings: (meetings: Meeting[]) => void;
}

function syncActive(recordingIds: Set<string>): boolean {
	return recordingIds.size > 0;
}

export const useMeetingRecordingStore = create<MeetingRecordingStore>(
	(set, get) => ({
		active: false,
		recordingIds: new Set(),
		applyEvent: (event) => {
			const ids = new Set(get().recordingIds);
			switch (event.type) {
				case "started":
					if (isRecordingStatus(event.meeting.status)) {
						ids.add(event.meeting.id);
					} else {
						ids.delete(event.meeting.id);
					}
					break;
				case "status":
					if (isRecordingStatus(event.status)) {
						ids.add(event.meeting_id);
					} else {
						ids.delete(event.meeting_id);
					}
					break;
				case "finalized":
					ids.delete(event.meeting.id);
					break;
				default:
					return;
			}
			set({ recordingIds: ids, active: syncActive(ids) });
		},
		seedFromMeetings: (meetings) => {
			const ids = recordingIdsFromMeetings(meetings);
			set({ recordingIds: ids, active: syncActive(ids) });
		},
		reset: () => set({ active: false, recordingIds: new Set() }),
	})
);
