import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";
import native from "./chat-page-native-http.playwright.config.ts";
import preparedStatic from "./chat-page-queue-static.playwright.config.ts";

// Keep the complete canonical native ChatPage discovery and browser assertions.
// Only the Vite development server is replaced by its authentic built output;
// the native HTTP host is freshly started with the same endpoints and reset API.
export default defineConfig({
	...native,
	forbidOnly: true,
	workers: 1,
	retries: 0,
	outputDir: path.join(tmpdir(), "ryu-chat-page-native-http-static-results"),
	webServer: preparedStatic.webServer,
});
