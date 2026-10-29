import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const buildDirectory = path.join(tmpdir(), "ryu-file-tree-actions-proof-build");
const project = await mkdtemp(
	path.join(tmpdir(), "ryu-file-tree-actions-project-")
);
// Empty, isolated NativeAuthStore namespace; actual installed SDK returns [value,exists].
const authStoreFile = `${project}-auth.bin.json`;
const authStoreRid = 4217;
let authStoreLoaded = false;
const authStoreKeys = new Set(["accounts", "activeUserId", "token"]);
const repository = path.resolve(desktop, "../..");
const bridgeManifest = path.join(
	repository,
	"docs/proof/test-coverage-sweep-20261008/central-pending-patches/file-tree-native/native-proof/Cargo.toml"
);
const bridgeTarget = path.join(tmpdir(), "ryu-file-tree-native-proof-target");
const bridgeExecutable = path.join(
	bridgeTarget,
	"debug",
	process.platform === "win32"
		? "ryu-workspace-move-proof.exe"
		: "ryu-workspace-move-proof"
);
const bridgeSourceInputs = [
	path.join(repository, "apps/desktop/src-tauri/src/workspace_move.rs"),
	path.join(repository, "apps/desktop/src-tauri/src/lib.rs"),
	path.join(repository, "apps/desktop/src-tauri/Cargo.toml"),
	path.join(repository, "apps/desktop/src-tauri/Cargo.lock"),
	path.join(repository, "apps/desktop/src-tauri/build.rs"),
	bridgeManifest,
	path.join(path.dirname(bridgeManifest), "Cargo.lock"),
	path.join(path.dirname(bridgeManifest), "src/lib.rs"),
	path.join(path.dirname(bridgeManifest), "src/main.rs"),
];
async function sourceHashes() {
	return Promise.all(
		bridgeSourceInputs.map(async (source) => ({
			path: source,
			sha256: createHash("sha256")
				.update(await readFile(source))
				.digest("hex"),
		}))
	);
}
const nativeSources = await sourceHashes();
const nativeBuild = Bun.spawn(
	[
		"cargo",
		"build",
		"--offline",
		"--manifest-path",
		bridgeManifest,
		"--target-dir",
		bridgeTarget,
		"--bin",
		"ryu-workspace-move-proof",
	],
	{ cwd: repository, stdout: "inherit", stderr: "inherit" }
);
if (await nativeBuild.exited)
	throw new Error("Actual production workspace filesystem bridge build failed");
if (JSON.stringify(nativeSources) !== JSON.stringify(await sourceHashes()))
	throw new Error("Native bridge source changed while compiling");
const nativeExecutableSha = createHash("sha256")
	.update(await readFile(bridgeExecutable))
	.digest("hex");
await Bun.write(
	path.join(tmpdir(), "ryu-file-tree-native-proof-provenance.json"),
	JSON.stringify(
		{
			sources: nativeSources,
			executable: bridgeExecutable,
			executableSha256: nativeExecutableSha,
			processVersion: process.version,
			bunVersion: Bun.version,
		},
		null,
		2
	)
);
async function native(args: string[]) {
	if (
		JSON.stringify(nativeSources) !== JSON.stringify(await sourceHashes()) ||
		createHash("sha256")
			.update(await readFile(bridgeExecutable))
			.digest("hex") !== nativeExecutableSha
	)
		throw new Error("Native fixture source/executable freshness changed");
	const process = Bun.spawn([bridgeExecutable, ...args], {
		cwd: repository,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	return { stdout, stderr, code };
}
let holdMove = false;
let heldMove: (() => void) | null = null;
const secondaryProject = await mkdtemp(
	path.join(tmpdir(), "ryu-file-tree-actions-alternate-")
);
const INITIAL = {
	"src/alpha.ts": "export const alpha = 'original bytes';\n",
	"src/beta.ts": "export const beta = 'untouched sibling';\n",
	"archive/keep.txt": "existing destination bytes\n",
};
const calls: { command: string; args: unknown; outcome: string }[] = [];
const unexpected: unknown[] = [];
let refuseList = false;
let refuseOpen = false;
async function git(args: string[], cwd = project) {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, code };
}
if ((await git(["init", "--quiet"])).code !== 0)
	throw new Error("Owned fixture git initialization failed");
if ((await git(["init", "--quiet"], secondaryProject)).code !== 0)
	throw new Error("Alternate fixture repository init failed");
async function reset() {
	if (
		heldMove ||
		calls.some(
			(call) =>
				call.command === "move_workspace_item" && call.outcome === "pending"
		)
	)
		throw new Error("Cannot reset pending native move");
	for (const name of await readdir(project)) {
		if (name !== ".git")
			await rm(path.join(project, name), { recursive: true, force: true });
	}
	for (const [name, bytes] of Object.entries(INITIAL)) {
		await mkdir(path.dirname(path.join(project, name)), { recursive: true });
		await Bun.write(path.join(project, name), bytes);
	}
	for (const name of await readdir(secondaryProject)) {
		if (name !== ".git")
			await rm(path.join(secondaryProject, name), {
				recursive: true,
				force: true,
			});
	}
	await mkdir(path.join(secondaryProject, "src"), { recursive: true });
	await Bun.write(
		path.join(secondaryProject, "src/other.ts"),
		"alternate project bytes\n"
	);
	await Bun.write(authStoreFile, "{}");
	authStoreLoaded = false;
	calls.length = 0;
	unexpected.length = 0;
	refuseList = false;
	refuseOpen = false;
	if (heldMove) throw new Error("Cannot reset with pending physical operation");
	holdMove = false;
}
await reset();
const build = Bun.spawn(
	[
		process.execPath,
		"x",
		"vite",
		"build",
		"--config",
		"e2e/harness/vite.file-tree-actions-proof.config.ts",
	],
	{ cwd: desktop, stdout: "inherit", stderr: "inherit" }
);
if (await build.exited)
	throw new Error("Production Files panel fixture build failed");
const json = (value: unknown, status = 200) => Response.json(value, { status });

async function snapshot() {
	const files: Record<string, string> = {};
	async function readDirectory(
		directory: string,
		prefix = "",
		destination = files
	) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (!prefix && entry.name === ".git") continue;
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
			const absolute = path.join(directory, entry.name);
			if (entry.isDirectory())
				await readDirectory(absolute, relative, destination);
			else if (entry.isFile())
				destination[relative] = await readFile(absolute, "utf8");
		}
	}
	await readDirectory(project);
	const secondaryFiles: Record<string, string> = {};
	await readDirectory(secondaryProject, "", secondaryFiles);
	return {
		project,
		files,
		secondaryProject,
		secondaryFiles,
		calls: structuredClone(calls),
		unexpected: structuredClone(unexpected),
		heldMove: heldMove !== null,
		nativeExecutableSha,
	};
}
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.RYU_FILE_TREE_ACTIONS_PORT ?? 5781),
	async fetch(request) {
		const route = new URL(request.url).pathname;
		if (route === "/__ready") return new Response("ready");
		if (
			route === "/api/plugins/contributions" &&
			request.method === "GET" &&
			request.headers.get("authorization") === "Bearer file-tree-proof-token"
		) {
			return json({ companions: [], file_handlers: [], themes: [] });
		}
		if (route.startsWith("/__file-tree/")) {
			if (request.headers.get("x-file-tree-proof") !== "finite-native-boundary")
				return json({ error: "Wrong fixture authority" }, 403);
			if (route === "/__file-tree/state" && request.method === "GET")
				return json(await snapshot());
			if (route === "/__file-tree/control" && request.method === "POST") {
				const { action } = (await request.json()) as { action: string };
				if (action === "reset") await reset();
				else if (action === "create_collision")
					await Bun.write(
						path.join(project, "src/blocked.ts"),
						"collision bytes remain intact\n"
					);
				else if (action === "create_drag_collision")
					await Bun.write(
						path.join(project, "archive/alpha.ts"),
						"destination collision bytes\n"
					);
				else if (action === "remove_collision")
					await rm(path.join(project, "src/blocked.ts"));
				else if (action === "hold_move_once" && !holdMove && !heldMove)
					holdMove = true;
				else if (action === "release_move" && heldMove) heldMove();
				else if (action === "track_initial") {
					const result = await git(["add", "--", "src", "archive"]);
					if (result.code) throw new Error(result.stderr);
				} else if (action === "refuse_list_once" && !refuseList)
					refuseList = true;
				else if (action === "refuse_open_once" && !refuseOpen)
					refuseOpen = true;
				else return json({ error: "Unknown fixture transition" }, 409);
				return json({ ok: true });
			}
			if (route === "/__file-tree/invoke" && request.method === "POST") {
				const body = (await request.json()) as {
					command: string;
					args?: Record<string, unknown>;
				};
				const args = body.args ?? {};
				const call = {
					command: body.command,
					args: body.args,
					outcome: "accepted",
				};
				calls.push(call);
				if (
					body.command === "list_workspace_files" &&
					Object.keys(args).join(",") === "root" &&
					typeof args.root === "string" &&
					[project, secondaryProject].includes(args.root)
				) {
					if (refuseList) {
						refuseList = false;
						call.outcome = "refused";
						return json({ error: "Fixture project listing refused" }, 503);
					}
					const result = await native(["--list", args.root as string]);
					if (result.code) {
						call.outcome = "refused";
						return json({ error: result.stderr.trim() }, 503);
					}
					return json({ result: JSON.parse(result.stdout) });
				}
				if (
					body.command === "move_workspace_item" &&
					Object.keys(args).sort().join(",") ===
						"destinationPath,root,sourcePath" &&
					args.root === project &&
					typeof args.sourcePath === "string" &&
					typeof args.destinationPath === "string"
				) {
					call.outcome = "pending";
					if (holdMove) {
						holdMove = false;
						await new Promise<void>((resolve) => {
							heldMove = resolve;
						});
						heldMove = null;
					}
					const result = await native([
						project,
						args.sourcePath,
						args.destinationPath,
					]);
					if (result.code) {
						call.outcome = "refused";
						return json({ error: result.stderr.trim() }, 409);
					}
					call.outcome = "accepted";
					return json({ result: null });
				}
				// This fixture mounts a signed-out Desktop. Permit only the existing
				// empty auth.bin store's load/read/save calls, never arbitrary resources.
				if (
					body.command === "plugin:store|load" &&
					args.path === "auth.bin" &&
					Object.keys(args).join(",") === "path"
				) {
					authStoreLoaded = true;
					return json({ result: authStoreRid });
				}
				if (authStoreLoaded && args.rid === authStoreRid) {
					if (
						body.command === "plugin:store|get" &&
						typeof args.key === "string" &&
						authStoreKeys.has(args.key) &&
						Object.keys(args).sort().join(",") === "key,rid"
					) {
						const values = (await Bun.file(authStoreFile).json()) as Record<
							string,
							unknown
						>;
						return json({
							result: [
								values[args.key] ?? null,
								Object.hasOwn(values, args.key),
							],
						});
					}
					if (
						body.command === "plugin:store|save" &&
						Object.keys(args).join(",") === "rid"
					) {
						return json({ result: null });
					}
				}
				if (
					body.command === "shell_execute" &&
					args.command ===
						"git ls-files --cached --others --exclude-standard" &&
					args.cwd === project &&
					args.shell === null &&
					Object.keys(args).sort().join(",") === "command,cwd,shell"
				) {
					if (refuseList) {
						refuseList = false;
						call.outcome = "refused";
						return json({
							result: {
								code: 128,
								stdout: "",
								stderr: "Fixture project listing refused",
							},
						});
					}
					return json({
						result: await git([
							"ls-files",
							"--cached",
							"--others",
							"--exclude-standard",
						]),
					});
				}
				if (
					body.command === "get_editor_availability" &&
					Object.keys(args).join(",") === "editors" &&
					Array.isArray(args.editors) &&
					args.editors.every((id) => typeof id === "string") &&
					new Set(args.editors).size === args.editors.length
				)
					return json({
						result: args.editors.map((id) => ({
							id,
							available: id === "explorer",
						})),
					});
				if (
					["open_workspace_item", "reveal_workspace_item"].includes(
						body.command
					) &&
					args.root === project &&
					args.editor === null &&
					typeof args.path === "string" &&
					Object.keys(args).sort().join(",") === "editor,path,root"
				) {
					const files = (await snapshot()).files;
					if (Object.hasOwn(files, args.path)) {
						if (refuseOpen) {
							refuseOpen = false;
							call.outcome = "refused";
							return json({ error: "Fixture native opener refused" }, 503);
						}
						return json({ result: null });
					}
				}
				call.outcome = "unexpected";
				unexpected.push({ command: body.command, args: body.args });
				return json({ error: "Unsupported exact native command/payload" }, 400);
			}
			return json({ error: "Unknown fixture route/method" }, 404);
		}
		if (request.method !== "GET" || route.startsWith("/api/")) {
			unexpected.push({ method: request.method, route });
			return json({ error: "Unsupported request" }, 404);
		}
		const absolute = path.resolve(
			buildDirectory,
			route === "/" ? "file-tree-actions-proof.html" : route.slice(1)
		);
		if (!absolute.startsWith(`${buildDirectory}/`))
			return new Response("Forbidden", { status: 403 });
		const file = Bun.file(absolute);
		return (await file.exists())
			? new Response(file)
			: new Response("Not found", { status: 404 });
	},
});
process.on("SIGTERM", () => {
	server.stop(true);
	process.exit(0);
});
