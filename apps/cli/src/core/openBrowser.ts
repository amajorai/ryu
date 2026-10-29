// Best-effort hand-off of a web page to the system browser. Every caller also
// prints the URL, so a machine with no opener (SSH session, headless box) only
// loses the shortcut, never the link.

/**
 * The command that opens `url`, or null when it is not a web address. Only
 * http(s) is opened: the URL can come from Core's responses, and `file:` or a
 * custom scheme would reach the system handler unchecked.
 */
export function browserOpenCommand(
	url: string,
	platform: NodeJS.Platform = process.platform
): string[] | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		return null;
	}
	if (platform === "win32") {
		// `cmd /c start` splits a URL at `&`; the URL handler takes it verbatim.
		return ["rundll32", "url.dll,FileProtocolHandler", parsed.href];
	}
	if (platform === "darwin") {
		return ["open", parsed.href];
	}
	return ["xdg-open", parsed.href];
}

/** Open `url` in the system browser; failures are ignored. */
export function openBrowser(url: string | null): void {
	if (!url) {
		return;
	}
	try {
		const bun = globalThis.Bun;
		if (!bun) {
			return;
		}
		const cmd = browserOpenCommand(url);
		if (!cmd) {
			return;
		}
		// Detached from the terminal: an opener's errors (no display, no
		// xdg-open) must not write into the TUI's raw-mode screen.
		bun.spawn(cmd, { stdio: ["ignore", "ignore", "ignore"] }).unref();
	} catch {
		// Best-effort only: the caller shows the URL.
	}
}
