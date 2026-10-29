import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const directory = process.env.RYU_TIME_CONSUMERS_DIST;
if (
	!(
		directory &&
		path.isAbsolute(directory) &&
		existsSync(path.join(directory, "time-consumers-proof.html"))
	)
) {
	throw new Error(
		"Build the authentic mounted Time consumers into RYU_TIME_CONSUMERS_DIST first"
	);
}
const port = Number(process.env.RYU_E2E_PORT ?? "5184");
if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
	throw new Error("Invalid owned Time consumer server port");
}
const baseURL = `http://127.0.0.1:${port}`;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export default defineConfig({
	testDir: ".",
	testMatch: "time-consumers.spec.ts",
	workers: 1,
	fullyParallel: false,
	retries: 0,
	forbidOnly: true,
	reporter: "line",
	use: {
		baseURL,
		...devices["Desktop Chrome"],
		timezoneId: "UTC",
		trace: "retain-on-failure",
		launchOptions: {
			executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
		},
	},
	webServer: {
		command: `python3 -m http.server ${port} --bind 127.0.0.1 --directory ${quote(directory)}`,
		url: `${baseURL}/time-consumers-proof.html`,
		reuseExistingServer: false,
		timeout: 30_000,
	},
});
