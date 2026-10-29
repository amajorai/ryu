import path from "node:path";
import { defineConfig } from "@playwright/test";
const node = process.env.RYU_APPEARANCE_NODE;
if (!node || !path.isAbsolute(node))
	throw new Error("Explicit pinned native Node interpreter required");
const chromium = process.env.RYU_CONSUMER_CHROMIUM_EXECUTABLE;
const viteCli = process.env.RYU_APPEARANCE_VITE_CLI;
const viteConfig = process.env.RYU_APPEARANCE_VITE_CONFIG;
for (const value of [chromium, viteCli, viteConfig]) {
	if (!value || !path.isAbsolute(value))
		throw new Error("Explicit pinned browser and owned Vite recipe required");
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
export default defineConfig({
	testDir: import.meta.dirname,
	testMatch: "appearance-preset-persistence-proof.browser.ts",
	workers: 1,
	fullyParallel: false,
	retries: 0,
	timeout: 60000,
	use: {
		launchOptions: { executablePath: chromium },
		baseURL: "http://127.0.0.1:33364",
		headless: true,
	},
	webServer: {
		command: `${quote(node)} ${quote(viteCli!)} --config ${quote(viteConfig!)}`,
		url: "http://127.0.0.1:33364/appearance-preset-persistence-proof.html",
		reuseExistingServer: false,
		timeout: 120000,
	},
});
