import { defineConfig, devices } from "@playwright/test";

const PROOF_URL = "http://127.0.0.1:5747/";

export default defineConfig({
	testDir: ".",
	testMatch: /interfaces-proof\.spec\.ts/,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: "list",
	use: {
		baseURL: PROOF_URL,
		trace: "retain-on-failure",
	},
	projects: [
		{
			name: "chromium",
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 1440, height: 900 },
				launchOptions: {
					executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
					// World 3D is a react-three-fiber scene. Headless Chromium has no
					// GPU, so route WebGL through ANGLE's SwiftShader software backend.
					args: [
						"--use-gl=angle",
						"--use-angle=swiftshader",
						"--enable-unsafe-swiftshader",
						"--ignore-gpu-blocklist",
					],
				},
			},
		},
	],
	webServer: {
		command: "bunx vite --config harness/vite.interfaces-story.config.ts",
		url: `${PROOF_URL}interfaces-story.html`,
		// Reuse a story server that is already running (design iteration keeps one up).
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
