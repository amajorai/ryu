// Main-process auto-update orchestration via electron-updater, plus the shared
// `auto-updates` Core preference (read AND write — the toggle is cross-surface).
//
// Unlike `services/appearance.ts` (read-only; the desktop owns its writes), the
// island's Updates settings section both reads and writes this pref, so the
// setting is shared with the desktop. The blob is the JSON string
// `{ "enabled": boolean }`; `shared/auto-update.ts` owns parsing/serialization.
//
// electron-updater is CommonJS, so it is imported as a default export and
// destructured (the named ESM import does not resolve under electron-vite).

import { app, type BrowserWindow } from "electron";
import electronUpdater from "electron-updater";
import {
	AUTO_UPDATE_PREF_KEY,
	parseAutoUpdate,
	serializeAutoUpdate,
} from "../../shared/auto-update.ts";
import type { UpdateState } from "../../shared/ipc.ts";
import { IPC } from "../../shared/ipc.ts";
import { coreHeaders, loadConfig } from "./config.ts";

const { autoUpdater } = electronUpdater;

/** Timeout for the one-shot pref read/write. */
const PREF_TIMEOUT_MS = 5000;

// The latest update lifecycle state, held in main so a settings panel that
// mounts AFTER an update already downloaded can still render the restart
// affordance (the `downloaded` event likely fired while the panel was closed).
let updateState: UpdateState = {
	available: false,
	downloaded: false,
	version: null,
};

/** The current update lifecycle state (read by the renderer on panel mount). */
export function getUpdateState(): UpdateState {
	return { ...updateState };
}

/** The running app version. Reliable when packaged (unlike `npm_package_version`). */
export function getAppVersion(): string {
	return app.getVersion();
}

/** Read the shared `auto-updates` pref; defaults to enabled on 404/unreachable. */
export async function getAutoUpdateEnabled(): Promise<boolean> {
	const { coreBaseUrl } = loadConfig();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PREF_TIMEOUT_MS);
	try {
		const resp = await fetch(
			`${coreBaseUrl}/api/preferences/${AUTO_UPDATE_PREF_KEY}`,
			{ method: "GET", headers: coreHeaders(), signal: controller.signal }
		);
		if (!resp.ok) {
			return parseAutoUpdate(null).enabled;
		}
		const data = (await resp.json()) as { value?: unknown };
		const raw = typeof data.value === "string" ? data.value : null;
		return parseAutoUpdate(raw).enabled;
	} catch {
		return parseAutoUpdate(null).enabled;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Write the shared `auto-updates` pref. Returns the value actually persisted
 * (the requested value on success, the current value on failure) so the renderer
 * never shows a toggle state that did not stick.
 */
export async function setAutoUpdateEnabled(enabled: boolean): Promise<boolean> {
	const { coreBaseUrl } = loadConfig();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PREF_TIMEOUT_MS);
	try {
		const resp = await fetch(
			`${coreBaseUrl}/api/preferences/${AUTO_UPDATE_PREF_KEY}`,
			{
				method: "PUT",
				headers: coreHeaders({ "Content-Type": "application/json" }),
				body: JSON.stringify({ value: serializeAutoUpdate({ enabled }) }),
				signal: controller.signal,
			}
		);
		return resp.ok ? enabled : await getAutoUpdateEnabled();
	} catch {
		return await getAutoUpdateEnabled();
	} finally {
		clearTimeout(timer);
	}
}

/** Push the current update state to the live renderer window, if any. */
function emit(channel: string, getWindow: () => BrowserWindow | null): void {
	const win = getWindow();
	if (win && !win.isDestroyed()) {
		win.webContents.send(channel, getUpdateState());
	}
}

/**
 * Attach electron-updater listeners and kick off the launch check.
 *
 * Listeners attach unconditionally (harmless in dev), but every trigger is
 * guarded by `app.isPackaged`: an unpackaged app has no update feed and
 * `checkForUpdates*` throws ("feed not provided"). The shared `auto-updates`
 * pref decides behaviour: enabled → `checkForUpdatesAndNotify()` (auto-download);
 * disabled → `autoDownload = false` + `checkForUpdates()` to merely surface
 * availability without downloading.
 */
export function initAutoUpdater(getWindow: () => BrowserWindow | null): void {
	autoUpdater.on("update-available", (info: { version?: string }) => {
		updateState = {
			...updateState,
			available: true,
			version: info?.version ?? updateState.version,
		};
		emit(IPC.update.available, getWindow);
	});
	autoUpdater.on("update-downloaded", (info: { version?: string }) => {
		updateState = {
			available: true,
			downloaded: true,
			version: info?.version ?? updateState.version,
		};
		emit(IPC.update.downloaded, getWindow);
	});

	if (!app.isPackaged) {
		// Dev: no feed configured; checking would throw. Stay a no-op.
		return;
	}

	getAutoUpdateEnabled()
		.then((enabled) => {
			if (enabled) {
				autoUpdater.autoDownload = true;
				return autoUpdater.checkForUpdatesAndNotify();
			}
			autoUpdater.autoDownload = false;
			return autoUpdater.checkForUpdates();
		})
		.catch(() => {
			// Network error / no release yet: fail open, stay up-to-date.
		});
}

/** Quit and install a downloaded update. No-op unless packaged + downloaded. */
export function quitAndInstall(): void {
	if (app.isPackaged && updateState.downloaded) {
		autoUpdater.quitAndInstall();
	}
}
