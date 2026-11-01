import type { Plugin } from "vite";

const HOST_ID = "\0browser-content-key-host";

/**
 * Proof harnesses render the desktop shell in a plain browser, with no native
 * host. The session snapshot (`ryu_session_tabs`) and workbench layout are
 * sealed by content-seal.ts under a key the host returns from
 * `desktop_content_key`; without a host that key stays locked, sealed writes
 * wait in memory, and a reload restores nothing.
 *
 * This plugin answers that one command for content-seal.ts the way a host
 * without a keychain key does (`null`), so content-seal falls back to the
 * browser device key (IndexedDB) exactly as it does on such a host, and a
 * reload opens what the page sealed. Only content-seal's own import of
 * `./tauri-ready.ts` is redirected, and it only ever calls `invokeWhenReady`
 * with `desktop_content_key`; every other module keeps its native seam.
 */
export function browserContentKeyHost(): Plugin {
	return {
		name: "browser-content-key-host",
		enforce: "pre",
		resolveId(source, importer) {
			return source === "./tauri-ready.ts" &&
				importer?.split("?")[0]?.endsWith("/src/lib/content-seal.ts")
				? HOST_ID
				: null;
		},
		load(id) {
			if (id !== HOST_ID) {
				return null;
			}
			return [
				"export function invokeWhenReady(command) {",
				'\tif (command === "desktop_content_key") {',
				"\t\treturn Promise.resolve(null);",
				"\t}",
				"\treturn Promise.reject(",
				'\t\tnew Error("content-seal host fixture does not answer " + command)',
				"\t);",
				"}",
			].join("\n");
		},
	};
}
