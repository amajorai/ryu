// Preload for the on-screen generative UI window. Deliberately minimal: the
// page renders agent-authored UI in a sandboxed renderer, so it gets only what
// drawing a screen needs — its state, the theme, the language-pack catalog,
// mouse capture, and the user's submit/close.
//
// Sandboxed: the only runtime imports allowed here are `electron` and
// `./surface-channels.ts` (which nothing else imports). Everything from
// `../shared/` must stay `import type`; see `sandbox.test.ts`.

import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
import type { LanguagePacksResult } from "../shared/ipc.ts";
import type {
	IslandSurfaceWindowApi,
	ScreenSurfaceRenderState,
} from "../shared/screen-surface.ts";
import { SCREEN_WINDOW_CHANNELS } from "./surface-channels.ts";

function subscribe<T>(
	channel: string,
	listener: (payload: T) => void
): () => void {
	const handler = (_event: IpcRendererEvent, payload: T): void =>
		listener(payload);
	ipcRenderer.on(channel, handler);
	return () => ipcRenderer.removeListener(channel, handler);
}

const api: IslandSurfaceWindowApi = {
	dismiss: (): void => ipcRenderer.send(SCREEN_WINDOW_CHANNELS.dismiss),
	languagePacks: {
		get: (): Promise<LanguagePacksResult> =>
			ipcRenderer.invoke(SCREEN_WINDOW_CHANNELS.languagePacksGet),
	},
	onState: (listener: (state: ScreenSurfaceRenderState) => void) =>
		subscribe(SCREEN_WINDOW_CHANNELS.state, listener),
	ready: (): void => ipcRenderer.send(SCREEN_WINDOW_CHANNELS.ready),
	setMouseCapture: (capture: boolean): void =>
		ipcRenderer.send(SCREEN_WINDOW_CHANNELS.setMouseCapture, capture),
	submit: (value: unknown): void =>
		ipcRenderer.send(SCREEN_WINDOW_CHANNELS.submit, value),
	theme: {
		get: (): Promise<string | null> =>
			ipcRenderer.invoke(SCREEN_WINDOW_CHANNELS.themeGet),
		onChanged: (listener: (value: string) => void) =>
			subscribe(SCREEN_WINDOW_CHANNELS.themeChanged, listener),
	},
};

contextBridge.exposeInMainWorld("islandSurface", api);
