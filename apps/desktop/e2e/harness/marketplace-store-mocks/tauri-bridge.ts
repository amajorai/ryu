export async function openExternal(url: string): Promise<void> {
	window.dispatchEvent(
		new CustomEvent("marketplace-store:external", { detail: url })
	);
}

// The Store graph reaches desktop modules (the installed-apps launcher, window
// routing, chat link previews) that import these bindings at module scope. ES
// modules must resolve every named import, so mirror what the real bridge does
// in a plain browser with no native shell: the standalone-window helpers use
// their web fallbacks, and native-only commands are unavailable.

class StoreHarnessShellUnavailableError extends Error {
	constructor(command: string) {
		super(`Native command "${command}" is unavailable without the Tauri shell`);
		this.name = "StoreHarnessShellUnavailableError";
	}
}

export interface LinkMetadataPreview {
	description?: string | null;
	image?: string | null;
	siteName?: string | null;
	title?: string | null;
	url: string;
}

export function previewLinkMetadata(
	_url: string
): Promise<LinkMetadataPreview> {
	return Promise.reject(
		new StoreHarnessShellUnavailableError("preview_link_metadata")
	);
}

export function openTabWindow(_options: {
	conversationId?: string;
	entityKey?: string;
	node?: string;
	path?: string;
	title?: string;
}): Promise<void> {
	return Promise.reject(
		new StoreHarnessShellUnavailableError("open_tab_window")
	);
}

export async function openStandaloneAppWindow(options: {
	appId: string;
	title: string;
}): Promise<void> {
	const url = new URL(window.location.href);
	url.pathname = "/";
	url.search = new URLSearchParams({
		appId: options.appId,
		window: "standalone-app",
	}).toString();
	const opened = window.open(url.toString(), "_blank", "noopener,noreferrer");
	if (!opened) {
		throw new Error("The standalone app window was blocked by the browser.");
	}
}

export async function closeCurrentWindow(): Promise<void> {
	window.close();
}
