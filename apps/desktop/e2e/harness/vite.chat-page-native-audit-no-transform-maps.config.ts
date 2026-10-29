import { defineConfig, mergeConfig } from "vite";
import auditedNative from "./vite.chat-page-native-audit.config.ts";

// Source-only capacity candidate: omit intermediate esbuild maps while retaining
// the shipping graph, resolver, CSS pipeline and default build minifier.
// Final build.sourcemap already defaults to false; no runtime call is replaced.
export default mergeConfig(
	auditedNative,
	defineConfig({
		esbuild: { sourcemap: false },
	})
);
