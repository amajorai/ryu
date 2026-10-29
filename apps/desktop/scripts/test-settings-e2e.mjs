import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withTestResourceLease } from "../../../tools/test-resource-lease.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function discoverSettingsConfigs(root) {
	const configs = [];
	function visit(directory) {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory() && entry.name !== "node_modules") {
				visit(path);
			} else if (
				entry.isFile() &&
				/(settings|tab)/u.test(entry.name) &&
				/\.playwright\.config\.[cm]?[jt]s$/u.test(entry.name)
			) {
				configs.push(path);
			}
		}
	}
	visit(join(root, "e2e"));
	return configs.sort();
}

export function runSettingsE2e({
	root = desktopRoot,
	cliPath = join(root, "node_modules/@playwright/test/cli.js"),
	environment = process.env,
	resourceOptions = {},
	outputRoot = tmpdir(),
	logger = console,
} = {}) {
	const configs = discoverSettingsConfigs(root);
	if (configs.length === 0) {
		throw new Error(
			"No desktop settings or tab Playwright configs were found."
		);
	}
	return withTestResourceLease(
		"browser",
		() => {
			const outputDirectory = mkdtempSync(
				join(outputRoot, "ryu-desktop-settings-")
			);
			const results = [];
			for (const [index, config] of configs.entries()) {
				const configName = relative(root, config);
				const output = join(outputDirectory, `${index}-${basename(config)}`);
				logger.info(`Desktop settings: ${configName}; artifacts: ${output}`);
				const result = spawnSync(
					process.execPath,
					[cliPath, "test", `--config=${configName}`, `--output=${output}`],
					{ cwd: root, env: environment, stdio: "inherit" }
				);
				if (result.error) {
					throw result.error;
				}
				if (result.signal || result.status === null) {
					throw new Error(
						`Desktop settings config ${configName} terminated ${result.signal ? `by ${result.signal}` : "without an exit status"}.`
					);
				}
				results.push({ config: configName, status: result.status, output });
			}
			return {
				results,
				exitCode: results.find((result) => result.status !== 0)?.status ?? 0,
				outputDirectory,
			};
		},
		{ ...resourceOptions, label: "Desktop settings browser sweep" }
	);
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		if (process.argv.length > 2) {
			throw new Error("Desktop settings sweep does not accept arguments.");
		}
		process.exitCode = runSettingsE2e().exitCode;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
