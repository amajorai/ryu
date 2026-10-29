import { defineConfig } from "@playwright/test";
import queue from "./chat-page-queue-static.playwright.config.ts";

// Reuse the same authentic prebuilt native Layout graph and HTTP/IPC fixture.
// Serial navigation cases never overlap the queue regression or its host.
export default defineConfig({
	...queue,
	testMatch: /chat-page-native-http-navigation-isolation\.spec\.ts$/,
});
