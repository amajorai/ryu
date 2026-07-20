// IPC handlers bridging the renderer to the main-process Shadow client.
//
// All Shadow methods are one-shot invoke/return calls that degrade gracefully,
// so no streaming or window reference is needed here.

import { ipcMain } from "electron";
import {
	type CaptureControlUpdate,
	type FeedbackRequest,
	IPC,
} from "../../shared/ipc.ts";
import {
	getCaptureControl,
	getCurrentContext,
	getProactive,
	getProactiveInbox,
	postFeedback,
	setCaptureControl,
} from "../services/shadow.ts";

/** Register all Shadow IPC handlers. */
export function registerShadowIpc(): void {
	ipcMain.handle(IPC.shadow.getCurrentContext, () => getCurrentContext());
	ipcMain.handle(IPC.shadow.getProactive, () => getProactive());
	ipcMain.handle(IPC.shadow.getProactiveInbox, () => getProactiveInbox());
	ipcMain.handle(IPC.shadow.postFeedback, (_event, req: FeedbackRequest) =>
		postFeedback(req)
	);
	ipcMain.handle(IPC.shadow.getCaptureControl, () => getCaptureControl());
	ipcMain.handle(
		IPC.shadow.setCaptureControl,
		(_event, update: CaptureControlUpdate) => setCaptureControl(update)
	);
}
