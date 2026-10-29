import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";
import { selectedDesktopBrowserStaticSuite } from "./desktop-browser-static-suites.ts";

const suite = selectedDesktopBrowserStaticSuite();
const directory = path.resolve(
	process.env.RYU_DESKTOP_BROWSER_DIST ??
		path.join(tmpdir(), `ryu-desktop-${suite.name}-static`)
);
for (const html of suite.html) {
	if (!existsSync(path.join(directory, html))) {
		throw new Error(
			`Build the authentic ${suite.name} graph first: missing ${html}`
		);
	}
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export default defineConfig({
	...suite.config,
	fullyParallel: false,
	forbidOnly: true,
	workers: 1,
	retries: 0,
	outputDir: path.join(tmpdir(), `ryu-desktop-${suite.name}-static-results`),
	use: { ...suite.config.use, trace: "retain-on-failure" },
	webServer: {
		command: `python3 -m http.server ${suite.port} --bind 127.0.0.1 --directory ${quote(directory)}`,
		url: `http://127.0.0.1:${suite.port}/${suite.html[0]}`,
		reuseExistingServer: false,
		timeout: 30_000,
	},
});
