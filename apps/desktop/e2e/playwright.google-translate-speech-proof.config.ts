import path from "node:path";
import { defineConfig } from "@playwright/test";
import base from "./playwright.gateway-dialog-accounts-proof.config.ts";

export default defineConfig({
	...base,
	testMatch: "google-translate-speech-proof.spec.ts",
	use: { ...base.use, baseURL: "http://127.0.0.1:5209" },
	webServer: {
		command:
			"bunx vite --config e2e/harness/vite.google-translate-speech-proof.config.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: "http://127.0.0.1:5209/gateway-dialog-accounts-proof.html",
		reuseExistingServer: true,
		timeout: 240_000,
	},
});
