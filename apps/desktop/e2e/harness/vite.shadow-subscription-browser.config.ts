// Scratch-cache wrapper around the shipping Shadow settings proof harness, so a
// browser run of the shadow-subscription spec writes no Vite cache in the repo.
// RYU_SHADOW_SUBSCRIPTION_SOURCE_OVERRIDE ("<path suffix>=<file>") serves one
// module from a scratch copy, for baseline and mutant runs; shipping files are
// never edited.
import { readFileSync } from "node:fs";
import { mergeConfig, type Plugin } from "vite";
import base from "./vite.shadow-computer-use-proof.config.ts";

const override = process.env.RYU_SHADOW_SUBSCRIPTION_SOURCE_OVERRIDE;
const plugins: Plugin[] = [];
if (override) {
	const [suffix, from] = override.split("=");
	if (!(suffix && from)) {
		throw new Error("Expected <path suffix>=<file>");
	}
	plugins.push({
		name: "shadow-subscription-source-override",
		enforce: "pre",
		load(id) {
			return id.split("?")[0]?.endsWith(suffix)
				? readFileSync(from, "utf8")
				: null;
		},
	});
}

export default mergeConfig(base, {
	cacheDir:
		process.env.RYU_SHADOW_SUBSCRIPTION_VITE_CACHE ??
		"/tmp/shadow-subscription-pw/vite-cache",
	plugins,
	server: { port: 5231, strictPort: true },
});
