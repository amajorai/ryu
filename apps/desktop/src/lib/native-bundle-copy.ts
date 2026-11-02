/**
 * English source for the desktop bundle's OS-rendered strings: the text macOS
 * reads from `Info.plist` before the webview (and its i18n runtime) exists.
 * Today that is only the microphone permission prompt.
 *
 * `scripts/sync-desktop-infoplist-strings.mjs` turns this table plus
 * `packages/i18n/locales/<locale>.json` into
 * `apps/desktop/src-tauri/locales/<lproj>.lproj/InfoPlist.strings`, which every
 * `tauri*.conf.json` copies into the app bundle through `bundle.macOS.files`.
 * Its `--check` (run by `bun run test:tools`) fails when a generated file, the
 * English `Info.plist` value, `CFBundleLocalizations` or a config drifts.
 *
 * - The key is the `Info.plist` key; the value is its exact English text, which
 *   must also be the `<string>` in `apps/desktop/src-tauri/Info.plist`.
 * - Values are plain sentences: no placeholders, no ICU plurals or selects.
 *
 * `tl()` here is an identity marker so `tools/i18n-extract` collects each
 * sentence into the catalogs; nothing in the app imports this module.
 */

const tl = (source: string): string => source;

export const NATIVE_BUNDLE_COPY = {
	NSMicrophoneUsageDescription: tl(
		"Ryu uses your microphone for voice input so you can speak to your agents instead of typing."
	),
} as const;

export type NativeBundleCopyKey = keyof typeof NATIVE_BUNDLE_COPY;
