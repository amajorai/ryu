// IPC bridge for quests (the auto-detecting todo list).
//
// Core owns the quest brain; this wires the renderer to it. accept/dismiss are
// invoke/return; quest events from Core's SSE stream are pushed to the live
// renderer on `IPC.quests.event`. The `suggested` event is proactive (it offers
// an unprompted "looks done?" chip) so it is consent-gated, mirroring the meeting
// `detected` prompt — events that merely reflect committed state pass through.

import { type BrowserWindow, ipcMain } from "electron";
import {
	IPC,
	type IslandQuestEvent,
	type IslandQuestResult,
} from "../../shared/ipc.ts";
import { shouldRunEngine } from "../services/consent.ts";
import {
	acceptQuest,
	dismissQuest,
	subscribeQuestEvents,
} from "../services/quests.ts";

let started = false;

/**
 * Register quest IPC handlers. `getWindow` returns the live renderer window so
 * forwarded events reach the current window. Safe to call once.
 */
export function registerQuestsIpc(getWindow: () => BrowserWindow | null): void {
	ipcMain.handle(
		IPC.quests.accept,
		(_event, id: string): Promise<IslandQuestResult> => acceptQuest(id)
	);
	ipcMain.handle(
		IPC.quests.dismiss,
		(_event, id: string): Promise<IslandQuestResult> => dismissQuest(id)
	);

	if (started) {
		return;
	}
	started = true;

	const controller = new AbortController();
	subscribeQuestEvents((event: IslandQuestEvent) => {
		// A `suggested` prompt is proactive — gate it on consent. Everything else
		// reflects committed state, so it always passes through.
		if (event.type === "suggested" && !shouldRunEngine()) {
			return;
		}
		const win = getWindow();
		if (win && !win.isDestroyed()) {
			win.webContents.send(IPC.quests.event, event);
		}
	}, controller.signal);
}
