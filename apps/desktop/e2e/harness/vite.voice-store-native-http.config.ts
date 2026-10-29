import original from "./vite.voice-settings-proof.config.ts";
import { defineConfig } from "vite";

// Reuse shipping Voice aliases, providers/CSS, harness root and UI port.
// This independent selection retains the accepted Voice16 recipe unchanged.
export default defineConfig({
	...original,
	optimizeDeps: {
		...original.optimizeDeps,
		entries: ["voice-store-native-http-outcomes.html"],
	},
});
