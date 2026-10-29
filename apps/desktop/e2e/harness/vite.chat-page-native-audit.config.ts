import { defineConfig, mergeConfig } from "vite";
import { nativeChatBuildInputAudit } from "./native-chat-build-input-audit.ts";
import nativeStatic from "./vite.chat-page-queue-static.config.ts";

// Preserve the exact authentic graph, resolver, CSS pipeline and build options.
export default mergeConfig(
	nativeStatic,
	defineConfig({
		plugins: [nativeChatBuildInputAudit()],
	})
);
