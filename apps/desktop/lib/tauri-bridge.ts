import { invoke } from "@tauri-apps/api/core";

export const startRyuCore = () => invoke<string>("start_ryu_core");
export const stopRyuCore = () => invoke<void>("stop_ryu_core");
export const getRyuStatus = () => invoke<string>("get_ryu_status");

/** Stop then start the Core process — the preflight page's "Restart" action. */
export const restartRyuCore = async (): Promise<string> => {
	await stopRyuCore().catch(() => undefined);
	return startRyuCore();
};
export const openExternal = (url: string) =>
	invoke<void>("open_external", { url });

/** Move a tab into a separate OS window (browser-style "open in new window").
 * The new window re-fetches the conversation by id and keeps targeting `node`. */
export const openTabWindow = (opts: {
	path?: string;
	conversationId?: string;
	node?: string;
	title?: string;
}) =>
	invoke<void>("open_tab_window", {
		path: opts.path ?? null,
		conversationId: opts.conversationId ?? null,
		node: opts.node ?? null,
		title: opts.title ?? null,
	});
