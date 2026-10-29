import { defineConfig } from "@playwright/test";
import base from "./voice-mode-call-proof.playwright.config.ts";

export default defineConfig({
	...base,
	testMatch: /voice-call-live-proof\.spec\.ts/,
});
