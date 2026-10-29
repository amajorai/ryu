import path from "node:path";
import { defineConfig } from "@playwright/test";

const baseURL = "http://127.0.0.1:5216";
const viteConfig = path.resolve(
	import.meta.dirname,
	"harness/vite.extension-waitlist-scope-proof.config.ts"
);
const viteBin = path.resolve(
	import.meta.dirname,
	"../node_modules/vite/bin/vite.js"
);

export default defineConfig({
	testDir: import.meta.dirname,
	testMatch: "extension-waitlist-scope-proof.spec.ts",
	fullyParallel: true,
	use: {
		baseURL,
		browserName: "chromium",
		viewport: { width: 420, height: 720 },
	},
	webServer: {
		command: `node "${viteBin}" --config "${viteConfig}"`,
		url: `${baseURL}/extension-waitlist-scope-proof.html`,
		reuseExistingServer: true,
		timeout: 60_000,
	},
});
