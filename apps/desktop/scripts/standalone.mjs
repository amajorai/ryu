import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Validate the fields this builder consumes while keeping the complete manifest
// in the carriage. Optional string fields retain the existing fallback behavior.
const manifestSchema = z.looseObject({
	id: z.string().min(1),
	name: z.string().catch(""),
	runnables: z
		.array(
			z.looseObject({
				kind: z.string(),
				config: z
					.looseObject({
						ui_entry: z.string().optional().catch(undefined),
					})
					.nullish(),
			})
		)
		.nullish(),
	sidecars: z
		.array(
			z.looseObject({
				name: z.string(),
				process: z
					.looseObject({
						kind: z.string().optional(),
						command: z.string().nullable().catch(null),
					})
					.nullish(),
			})
		)
		.nullish(),
});
const packageSchema = z.object({
	scripts: z
		.object({
			build: z.string().optional().catch(undefined),
		})
		.nullish(),
});

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(desktopDir, "../..");
const appArgument = process.argv[2];
const tauriArgs = process.argv.slice(3).filter((argument) => argument !== "--");

if (!appArgument) {
	console.error(
		"Usage: bun run build:standalone <app-directory-or-plugin-id> [tauri args]"
	);
	process.exit(2);
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function standaloneProductName(manifest) {
	const name = manifest.name.trim();
	return name || "Ryu App";
}

function standaloneIdentifier(appId) {
	const slug = appId
		.replace(/[^a-zA-Z0-9]+/g, ".")
		.replace(/^\.+|\.+$/g, "")
		.toLowerCase();
	return `ai.amajor.ryu.app.${slug || "app"}`;
}

function writeStandaloneTauriConfig(manifest) {
	const configPath = join(
		desktopDir,
		"src-tauri",
		".tauri.standalone.generated.json"
	);
	const config = readJson(
		join(desktopDir, "src-tauri", "tauri.standalone.conf.json")
	);
	const productName = standaloneProductName(manifest);
	config.productName = productName;
	config.mainBinaryName = productName;
	config.identifier = standaloneIdentifier(manifest.id);
	config.app.windows = (config.app.windows ?? []).map((window) => ({
		...window,
		title: productName,
	}));
	writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
	return configPath;
}

function findAppDirectory(argument) {
	const supplied = resolve(argument);
	if (existsSync(join(supplied, "manifest.json"))) {
		return supplied;
	}
	const direct = join(repoDir, "apps-store", argument);
	if (existsSync(join(direct, "manifest.json"))) {
		return direct;
	}
	for (const entry of readdirSync(join(repoDir, "apps-store"), {
		withFileTypes: true,
	})) {
		if (!entry.isDirectory()) {
			continue;
		}
		const appName = entry.name;
		const manifestPath = join(repoDir, "apps-store", appName, "manifest.json");
		if (!existsSync(manifestPath)) {
			continue;
		}
		if (
			z.object({ id: z.string() }).parse(readJson(manifestPath)).id === argument
		) {
			return join(repoDir, "apps-store", appName);
		}
	}
	return null;
}

function uiEntryPath(appDir, uiDir, entry) {
	const relative = entry.replace(/^\.\//, "");
	const fromApp = resolve(appDir, relative);
	if (existsSync(fromApp)) {
		return fromApp;
	}
	if (uiDir) {
		const fromUi = resolve(uiDir, relative);
		if (existsSync(fromUi)) {
			return fromUi;
		}
	}
	return null;
}

function buildUiIfNeeded(appDir, manifest) {
	const companion = (manifest.runnables ?? []).find(
		(runnable) => runnable.kind === "companion"
	);
	const entry = companion?.config?.ui_entry;
	if (!entry?.trim()) {
		return null;
	}
	const fixture = join(
		repoDir,
		"apps/core/src/plugin_manifest/fixtures",
		`${basename(appDir)}.ui.html`
	);
	if (existsSync(fixture)) {
		return readFileSync(fixture, "utf8");
	}
	const uiDir = existsSync(join(appDir, "ui", "package.json"))
		? join(appDir, "ui")
		: existsSync(join(appDir, "sidecar", "package.json"))
			? join(appDir, "sidecar")
			: null;
	const companionHtml = uiDir ? join(uiDir, "companion.html") : null;
	if (companionHtml && existsSync(companionHtml)) {
		return readFileSync(companionHtml, "utf8");
	}
	let path = uiEntryPath(appDir, uiDir, entry);
	if (!(path || uiDir)) {
		const packagePath = join(appDir, "package.json");
		const packageJson = existsSync(packagePath)
			? packageSchema.parse(readJson(packagePath))
			: null;
		const buildScript = packageJson?.scripts?.build;
		if (buildScript !== undefined) {
			if (
				existsSync(join(appDir, "bun.lock")) &&
				!existsSync(join(appDir, "node_modules"))
			) {
				const install = spawnSync("bun", ["install", "--frozen-lockfile"], {
					cwd: appDir,
					encoding: "utf8",
					stdio: "inherit",
				});
				if (install.status !== 0) {
					throw new Error(
						`Companion dependencies could not be installed for ${manifest.id}.`
					);
				}
			}
			const result = spawnSync("bun", ["run", "build"], {
				cwd: appDir,
				env: { ...process.env, VITE_RYU_HOST: "true" },
				encoding: "utf8",
				stdio: "inherit",
			});
			if (result.status !== 0) {
				throw new Error(`Companion build failed for ${manifest.id}.`);
			}
			path = uiEntryPath(appDir, uiDir, entry);
		}
	}
	if (!path && uiDir) {
		const packagePath = join(uiDir, "package.json");
		const packageJson = existsSync(packagePath)
			? packageSchema.parse(readJson(packagePath))
			: null;
		const buildScript = packageJson?.scripts?.build;
		if (
			buildScript?.includes("vite") &&
			existsSync(join(uiDir, "bun.lock")) &&
			!existsSync(join(uiDir, "node_modules", ".bin", "vite"))
		) {
			const install = spawnSync("bun", ["install", "--frozen-lockfile"], {
				cwd: uiDir,
				encoding: "utf8",
				stdio: "inherit",
			});
			if (install.status !== 0) {
				throw new Error(
					`Companion dependencies could not be installed for ${manifest.id}.`
				);
			}
		}
		const result = spawnSync("bun", ["run", "build"], {
			cwd: uiDir,
			encoding: "utf8",
			stdio: "inherit",
		});
		if (result.status !== 0) {
			throw new Error(`Companion build failed for ${manifest.id}.`);
		}
		path = uiEntryPath(appDir, uiDir, entry);
	}
	if (!path) {
		throw new Error(
			`Companion ${manifest.id} declares ${entry}, but no self-contained HTML bundle exists.`
		);
	}
	return readFileSync(path, "utf8");
}

function buildEmbeddedSidecars(appDir, manifest) {
	const resourcesDir = join(desktopDir, "standalone-resources");
	const resourceRoot = join(resourcesDir, "sidecars");
	rmSync(resourcesDir, {
		recursive: true,
		force: true,
	});
	mkdirSync(resourceRoot, { recursive: true });
	writeFileSync(
		join(resourceRoot, ".keep"),
		"standalone app resources\n",
		"utf8"
	);
	const debugBuild = tauriArgs.includes("--debug");
	const profile = debugBuild ? "debug" : "release";
	const resources = [];
	for (const sidecar of manifest.sidecars ?? []) {
		const processSpec = sidecar.process ?? {};
		const command = processSpec.command ?? null;
		const backendManifest = join(appDir, "backend", "Cargo.toml");
		if (processSpec.kind !== "local" || !command) {
			resources.push({
				command,
				commandEnv: processSpec.command_env,
				mode: "core-provisioned",
				name: sidecar.name,
			});
			continue;
		}

		let source;
		let expectedEmbeddedSource = false;
		if (existsSync(backendManifest)) {
			expectedEmbeddedSource = true;
			const cargoArgs = ["build", "--manifest-path", backendManifest];
			if (!debugBuild) {
				cargoArgs.push("--release");
			}
			const result = spawnSync("cargo", cargoArgs, {
				cwd: repoDir,
				encoding: "utf8",
				stdio: "inherit",
			});
			if (result.status !== 0) {
				throw new Error(`Sidecar build failed for ${sidecar.name}.`);
			}
			const extension = process.platform === "win32" ? ".exe" : "";
			source = join(repoDir, "target", profile, `${command}${extension}`);
		} else {
			const sidecarPackagePath = join(appDir, "sidecar", "package.json");
			const sidecarPackage = existsSync(sidecarPackagePath)
				? packageSchema.parse(readJson(sidecarPackagePath))
				: null;
			const buildScript = sidecarPackage?.scripts?.build;
			if (buildScript?.includes("--compile")) {
				expectedEmbeddedSource = true;
				const result = spawnSync("bun", ["run", "build"], {
					cwd: dirname(sidecarPackagePath),
					encoding: "utf8",
					stdio: "inherit",
				});
				if (result.status !== 0) {
					throw new Error(`Sidecar build failed for ${sidecar.name}.`);
				}
				const extension = process.platform === "win32" ? ".exe" : "";
				source = [
					join(appDir, "sidecar", "dist", `${command}${extension}`),
					join(appDir, "sidecar", "dist", command),
					join(appDir, "dist", `${command}${extension}`),
				].find((candidate) => existsSync(candidate));
			}
		}
		if (!(source && existsSync(source))) {
			if (expectedEmbeddedSource) {
				throw new Error(
					`Standalone sidecar artifact is missing for ${sidecar.name}.`
				);
			}
			resources.push({
				command,
				commandEnv: processSpec.command_env,
				mode: "core-provisioned",
				name: sidecar.name,
			});
			continue;
		}
		const resourceName = basename(source);
		const destination = join(resourceRoot, resourceName);
		copyFileSync(source, destination);
		chmodSync(destination, 0o755);
		const sha256 = createHash("sha256")
			.update(readFileSync(destination))
			.digest("hex");
		resources.push({
			command,
			commandEnv: processSpec.command_env,
			mode: "embedded",
			name: sidecar.name,
			resourcePath: `standalone/sidecars/${resourceName}`,
			sha256,
		});
	}
	return resources;
}

const appDir = findAppDirectory(appArgument);
if (!appDir) {
	console.error(`Unknown Ryu app '${appArgument}'.`);
	process.exit(2);
}

const manifestPath = join(appDir, "manifest.json");
const rawManifest = readJson(manifestPath);
const manifest = manifestSchema.parse(rawManifest);
const uiCode = buildUiIfNeeded(appDir, manifest);
const sidecars = buildEmbeddedSidecars(appDir, manifest);
if (uiCode !== null) {
	rawManifest.ui_code_sha256 = createHash("sha256")
		.update(uiCode, "utf8")
		.digest("hex");
}

const bundleDir = mkdtempSync(join(tmpdir(), "ryu-standalone-app-"));
const bundlePath = join(bundleDir, "app-bundle.json");
writeFileSync(
	bundlePath,
	JSON.stringify(
		{
			schemaVersion: 1,
			appId: manifest.id,
			appName: rawManifest.name,
			version: rawManifest.version,
			manifest: rawManifest,
			sidecars,
			uiCode,
		},
		null,
		2
	),
	"utf8"
);

if (tauriArgs.includes("--prepare-only")) {
	console.log(`prepared standalone carriage for ${manifest.id}: ${bundlePath}`);
	rmSync(join(desktopDir, "standalone-resources"), {
		recursive: true,
		force: true,
	});
	process.exit(0);
}

const env = {
	...process.env,
	RYU_STANDALONE_APP_ID: manifest.id,
	RYU_STANDALONE_APP_BUNDLE: bundlePath,
	VITE_RYU_PRODUCT: "app",
};
const generatedConfigPath = writeStandaloneTauriConfig(manifest);
let result;
try {
	result = spawnSync(
		"bun",
		[
			"run",
			"tauri",
			"build",
			"--config",
			"src-tauri/.tauri.standalone.generated.json",
			...tauriArgs,
		],
		{
			cwd: desktopDir,
			env,
			encoding: "utf8",
			stdio: "inherit",
		}
	);
} finally {
	rmSync(join(desktopDir, "standalone-resources"), {
		recursive: true,
		force: true,
	});
	rmSync(generatedConfigPath, { force: true });
	rmSync(bundleDir, { recursive: true, force: true });
}
process.exit(result?.status ?? 1);
