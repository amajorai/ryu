// IPC bridge for meeting notes.
//
// Core owns the meeting brain; this wires the renderer to it. start/finalize are
// invoke/return; meeting events from Core's SSE stream are pushed to the live
// renderer on `IPC.meetings.event`. Auto-detection prompts (`detected` events)
// are consent-gated — they only reach the renderer when the proactive grant is
// in place, mirroring the suggestion engine — while events that respond to a
// user's own action (started/status/finalized) always pass through.

import { type BrowserWindow, ipcMain } from "electron";
import {
	IPC,
	type IslandMeetingEvent,
	type IslandMeetingResult,
	type IslandStartMeetingInput,
} from "../../shared/ipc.ts";
import { shouldRunEngine } from "../services/consent.ts";
import {
	finalizeMeeting,
	startMeeting,
	subscribeMeetingEvents,
} from "../services/meetings.ts";

let started = false;

/**
 * Register meeting IPC handlers. `getWindow` returns the live renderer window so
 * forwarded events reach the current window. Safe to call once.
 */
export function registerMeetingsIpc(
	getWindow: () => BrowserWindow | null
): void {
	ipcMain.handle(
		IPC.meetings.start,
		(
			_event,
			input: IslandStartMeetingInput = {}
		): Promise<IslandMeetingResult> => startMeeting(input)
	);
	ipcMain.handle(
		IPC.meetings.finalize,
		(_event, id: string): Promise<IslandMeetingResult> => finalizeMeeting(id)
	);

	if (started) {
		return;
	}
	started = true;

	const controller = new AbortController();
	subscribeMeetingEvents((event: IslandMeetingEvent) => {
		// A `detected` prompt is proactive — gate it on consent. Everything else
		// responds to the user's own start/stop, so it always passes through.
		if (event.type === "detected" && !shouldRunEngine()) {
			return;
		}
		const win = getWindow();
		if (win && !win.isDestroyed()) {
			win.webContents.send(IPC.meetings.event, event);
		}
	}, controller.signal);
}
