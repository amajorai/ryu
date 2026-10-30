import {
	htmlCompanionSrcdoc,
	thirdPartyPluginSrcdoc,
} from "@ryu/app-host/third-party-plugin";
import { useMemo } from "react";
import type { PluginCompanion } from "@/src/lib/api/plugins.ts";
import type { readHostThemeTokens } from "./PluginHostPanel-theme-tokens.ts";

/** Base64-encode a UTF-8 string (btoa is Latin-1 only). Used to inline the plugin
 *  bundle into the sandboxed `srcdoc` so a body containing `</script>` cannot
 *  break the tag (defense in depth; the sandbox is the real boundary). */
function toBase64Utf8(input: string): string {
	const bytes = new TextEncoder().encode(input);
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

/** Build the sandboxed frame document for the fetched companion bundle. */
export function usePluginHostSrcdoc({
	closeOnEscape,
	code,
	companion,
	initialThemeTokens,
	isHtmlBundle,
	mountContext,
	nonce,
}: {
	closeOnEscape: boolean;
	code: string | null | undefined;
	companion: PluginCompanion;
	initialThemeTokens: ReturnType<typeof readHostThemeTokens>;
	isHtmlBundle: boolean;
	mountContext: unknown;
	nonce: string;
}) {
	const srcdoc = useMemo(() => {
		if (!code) {
			return null;
		}
		// Path B (ui_format:"html"): a full self-contained HTML bundle (a heavy app
		// like the whiteboard, built via vite-plugin-singlefile) is mounted directly
		// as srcdoc with the window.ryu bridge injected inline — no new Function eval.
		// Content-sniff the fetched bundle so the panel needs no extra plumbing: a
		// `ui_format:"html"` companion's ui_code always starts with a doctype/<html>,
		// while a Path A ESM module never does.
		if (isHtmlBundle) {
			return htmlCompanionSrcdoc(
				nonce,
				code,
				companion.id,
				mountContext,
				companion.csp,
				initialThemeTokens,
				true,
				{ enforceDefaultCsp: companion.defaultCspEnforced, closeOnEscape }
			);
		}
		return thirdPartyPluginSrcdoc(
			nonce,
			toBase64Utf8(code),
			companion.id,
			mountContext,
			initialThemeTokens,
			true,
			{ enforceDefaultCsp: companion.defaultCspEnforced, closeOnEscape }
		);
	}, [
		code,
		isHtmlBundle,
		nonce,
		companion.id,
		companion.csp,
		companion.defaultCspEnforced,
		closeOnEscape,
		mountContext,
		initialThemeTokens,
	]);
	return srcdoc;
}
