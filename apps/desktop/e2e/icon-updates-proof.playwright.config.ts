import { defineConfig } from "@playwright/test";
import base from "./voice-mode-call-proof.playwright.config.ts";

export default defineConfig({
	...base,
	testMatch: /icon-updates-proof\.spec\.ts/,
	webServer: {
		...base.webServer,
		command: "bunx vite --config harness/vite.icon-updates-proof.config.ts",
	},
});
