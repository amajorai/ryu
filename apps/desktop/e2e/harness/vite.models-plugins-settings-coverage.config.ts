import { existsSync } from "node:fs";
import path from "node:path";
import { mergeConfig, type PluginOption, type UserConfig } from "vite";

// Serves one existing models/plugins settings proof harness, chosen by
// RYU_MODELS_PLUGINS_HARNESS (a config file name next to this one or in e2e/),
// with a /tmp dependency cache so revalidation runs never write Vite's cache
// into the checkout. Port, root, aliases and plugins come from the harness's
// own config unchanged. RYU_MODELS_PLUGINS_VITE_PLUGINS may name an absolute
// module path whose default export is a list of extra Vite plugins (a scratch
// mutation-testing loader kept outside the checkout); ordinary runs leave it
// unset.
const harness = process.env.RYU_MODELS_PLUGINS_HARNESS;
if (!harness || harness.includes("/") || !harness.endsWith(".ts")) {
	throw new Error(
		"Set RYU_MODELS_PLUGINS_HARNESS to an existing harness config file name"
	);
}
const candidates = [
	path.resolve(import.meta.dirname, harness),
	path.resolve(import.meta.dirname, "..", harness),
];
const file = candidates.find((candidate) => existsSync(candidate));
if (!file) {
	throw new Error(`Unknown harness config ${harness}`);
}
const base = (await import(file)).default as UserConfig;
const cacheRoot =
	process.env.RYU_MODELS_PLUGINS_VITE_CACHE ??
	"/tmp/models-plugins-settings-coverage/vite-cache";

const extraPluginsModule = process.env.RYU_MODELS_PLUGINS_VITE_PLUGINS;
const extraPlugins: PluginOption[] = extraPluginsModule
	? ((await import(extraPluginsModule)).default as PluginOption[])
	: [];

export default mergeConfig(base, {
	cacheDir: path.join(cacheRoot, harness.replace(/\.ts$/, "")),
	plugins: extraPlugins,
});
