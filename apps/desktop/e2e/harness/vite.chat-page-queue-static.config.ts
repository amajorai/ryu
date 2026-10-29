import path from "node:path";
import { defineConfig, mergeConfig } from "vite";
import native from "./vite.chat-page-native-http.config.ts";

// Preserve the authentic Layout/ChatPage source graph and production CSS.
export default mergeConfig(
	native,
	defineConfig({
		build: {
			rollupOptions: {
				input: path.join(import.meta.dirname, "chat-page-native-http.html"),
			},
		},
	})
);
