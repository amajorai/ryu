/**
 * Test preload — mocks the native addon so the SDK's zod schema loads without it.
 *
 * `@ryuhq/sdk/manifest` does a top-level `import * as nativeAddon from
 * "@ryuhq/sdk-native"` (packages/sdk/src/manifest.ts), whose prebuilt `.node`
 * fails `dlopen` in some environments (e.g. an unrebuilt darwin-arm64 binary).
 * The zod `PluginManifestSchema` (and every `defineX` factory) never call the
 * native addon — only `validatePluginId` / `validateManifestStrict` /
 * `coreManifestJsonSchema` do — so mocking the module lets the schema-level
 * validation this suite exercises run for real, independent of the binary.
 *
 * Registered via bunfig.toml `[test].preload` so it runs BEFORE the test files'
 * static imports resolve the module graph.
 */

import { mock } from "bun:test";

mock.module("@ryuhq/sdk-native", () => ({
	validatePluginId: () => {
		// no-op stub — not exercised by the schema-level tests
	},
	parseAndValidateManifest: (manifestJson: string) => manifestJson,
	pluginManifestJsonSchema: () => "{}",
}));
