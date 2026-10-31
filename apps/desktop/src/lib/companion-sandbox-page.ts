/**
 * Where a contributed companion's sandboxed document is loaded from.
 *
 * Desktop and web mount the document as `about:srcdoc` (their shell CSP allows
 * the frame's inline bootstrap), so there is no sandbox page here. The browser
 * extension replaces this module at bundle time (`desktopSeamReplacements` in
 * `apps/extension/wxt.config.ts`) with its declared MV3 sandbox page, because the
 * dashboard's `script-src 'self'` would block an inherited srcdoc.
 */
export function companionSandboxPage(
	_defaultCspEnforced: boolean
): string | undefined {
	return;
}
