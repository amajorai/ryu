import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.RYU_WEB_E2E_PORT ?? "5196");
const proofUrl = `http://127.0.0.1:${port}/`;

export default defineConfig({
	testDir: ".",
	testMatch: /website-org-dashboard-notification-proof\.spec\.ts$/,
	fullyParallel: false,
	reporter: "line",
	use: {
		...devices["Desktop Chrome"],
		baseURL: proofUrl,
	},
	webServer: {
		command: `bunx vite --config harness/vite.website-org-dashboard-notification-proof.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
		url: `${proofUrl}website-org-dashboard-notification-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
