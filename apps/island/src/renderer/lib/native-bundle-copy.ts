/**
 * English source for Ryu Island's OS-rendered bundle strings: the text macOS
 * reads from `Info.plist` outside any renderer (and its i18n runtime). Today
 * that is only the microphone permission prompt.
 *
 * `scripts/sync-island-infoplist-strings.mjs` turns this table plus
 * `packages/i18n/locales/<locale>.json` into
 * `apps/island/resources/locales/<lproj>.lproj/InfoPlist.strings`, which
 * `apps/island/electron-builder.yml` copies into the app bundle through
 * `mac.extraResources`. Its `--check` fails when a generated file, the
 * `mac.extendInfo` English value or the copy list drifts.
 *
 * - The key is the `Info.plist` key; the value is its exact English text, which
 *   must also be the `mac.extendInfo` value in `electron-builder.yml`.
 * - Values are plain sentences: no placeholders, no ICU plurals or selects.
 *
 * `tl()` here is an identity marker so `tools/i18n-extract` collects each
 * sentence into the catalogs; nothing in the app imports this module.
 */

const tl = (source: string): string => source;

export const NATIVE_BUNDLE_COPY = {
	NSMicrophoneUsageDescription: tl(
		"Ryu Island uses the microphone for voice input."
	),
} as const;

export type NativeBundleCopyKey = keyof typeof NATIVE_BUNDLE_COPY;
