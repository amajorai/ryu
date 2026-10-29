import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";

const desktopDirectory = path.resolve(import.meta.dirname, "..");
const repositoryDirectory = path.resolve(desktopDirectory, "../..");
const sidecarBinary = path.join(
	repositoryDirectory,
	"target/debug/ryu-security"
);
const uiBuildDirectory = `${tmpdir()}/ryu-security-companion-ui-build`;
const hostBuildDirectory = `${tmpdir()}/ryu-security-companion-host-build`;
const fixtureDirectory = await mkdtemp(
	path.join(tmpdir(), "ryu-security-companion-proof-")
);
const dataDirectory = path.join(fixtureDirectory, "ryu-data");
const codebaseRepository = path.join(fixtureDirectory, "codebase-repository");
const changesRepository = path.join(fixtureDirectory, "changes-repository");
const token = randomUUID();

async function runRtk(args: string[], cwd: string): Promise<void> {
	// rtk only condenses output; hosts without it (CI) run the command directly.
	const rtkExecutable = Bun.which("rtk");
	const build = Bun.spawn(rtkExecutable ? [rtkExecutable, ...args] : args, {
		cwd,
		stderr: "inherit",
		stdout: "inherit",
	});
	const exitCode = await build.exited;
	if (exitCode !== 0) {
		throw new Error(`${args.join(" ")} failed with exit code ${exitCode}.`);
	}
}

async function reservePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const reservation = createServer();
		reservation.once("error", reject);
		reservation.listen(0, "127.0.0.1", () => {
			const address = reservation.address();
			if (!address || isNativeText(address)) {
				reservation.close();
				reject(new Error("Could not reserve a local Security sidecar port."));
				return;
			}
			reservation.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(address.port);
			});
		});
	});
}

function runGit(repository: string, args: string[]): void {
	const result = Bun.spawnSync(["git", ...args], {
		cwd: repository,
		stderr: "inherit",
		stdout: "inherit",
	});
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed in a proof fixture.`);
	}
}

async function createRepository(
	repository: string,
	files: Record<string, string>,
	commit: boolean
): Promise<void> {
	for (const [relativePath, contents] of Object.entries(files)) {
		const destination = path.join(repository, relativePath);
		await mkdir(path.dirname(destination), { recursive: true });
		await writeFile(destination, contents, "utf8");
	}
	if (!commit) {
		return;
	}
	runGit(repository, ["init", "-q"]);
	runGit(repository, ["config", "user.name", "Security Proof"]);
	runGit(repository, ["config", "user.email", "security-proof@localhost"]);
	runGit(repository, ["add", "."]);
	runGit(repository, ["commit", "-qm", "Fixture baseline"]);
}

await runRtk(
	["cargo", "build", "--offline", "-p", "ryu-security"],
	repositoryDirectory
);
await runRtk(
	[
		"bun",
		"x",
		"vite",
		"build",
		"--config",
		"../../apps-store/security/ui/vite.config.ts",
		"--outDir",
		uiBuildDirectory,
	],
	desktopDirectory
);
await runRtk(
	[
		"bun",
		"x",
		"vite",
		"build",
		"--config",
		"e2e/harness/vite.security-companion-proof.config.ts",
	],
	desktopDirectory
);

await mkdir(dataDirectory, { recursive: true });
await createRepository(
	codebaseRepository,
	{
		"src/security.ts": "export const result = eval(input);\n",
		"src/deserialization.py": "result = pickle.loads(payload)\n",
		"src/safe.ts": "export const normalized = input.trim();\n",
		"tests/out-of-scope.ts": "export const testResult = eval(input);\n",
		"node_modules/ignored.ts": "export const packageResult = eval(input);\n",
	},
	true
);
await createRepository(
	changesRepository,
	{ "src/route.ts": "export const route = input.trim();\n" },
	true
);
await writeFile(
	path.join(changesRepository, "src/route.ts"),
	"export const route = eval(input);\n",
	"utf8"
);

const sidecarPort = await reservePort();
const sidecarProcess = spawn(sidecarBinary, [], {
	env: {
		...process.env,
		RYU_EXT_TOKEN: token,
		RYU_CORE_PORT: "",
		RYU_PROFILE: "dev",
		RYU_KEYCHAIN: "off",
		RYU_DIR: dataDirectory,
		RYU_SECURITY_PORT: String(sidecarPort),
		RYU_MANAGED_NODE: "0",
		RUST_LOG: "warn",
	},
	stdio: "inherit",
});

let sidecarReady = false;
for (let attempt = 0; attempt < 120; attempt += 1) {
	if (sidecarProcess.exitCode !== null) {
		throw new Error("The local ryu-security sidecar exited during startup.");
	}
	sidecarReady = await fetch(`http://127.0.0.1:${sidecarPort}/health`).then(
		(response) => response.ok,
		() => false
	);
	if (sidecarReady) {
		break;
	}
	await Bun.sleep(100);
}
if (!sidecarReady) {
	sidecarProcess.kill();
	await rm(fixtureDirectory, { force: true, recursive: true });
	throw new Error("The local ryu-security sidecar did not become healthy.");
}

let failNext: { method: string; path: string; status: number } | null = null;
const hostPort = Number(process.env.RYU_SECURITY_PROOF_PORT ?? 5439);
const host = Bun.serve({
	hostname: "127.0.0.1",
	port: hostPort,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/__ready") {
			return Response.json({ ok: true, sidecarReady });
		}
		if (url.pathname === "/__proof/fixtures") {
			return Response.json({
				changesRepository,
				codebaseRepository,
			});
		}
		if (url.pathname === "/__proof/fail-next" && request.method === "POST") {
			const value = await request.json();
			failNext = value;
			return Response.json({ armed: true });
		}
		if (url.pathname.startsWith("/__proof/security")) {
			const apiPath = url.pathname.slice("/__proof/security".length);
			if (failNext?.method === request.method && failNext.path === apiPath) {
				const failure = failNext;
				failNext = null;
				return Response.json(
					{
						error: {
							code: "fixture_failure",
							message: "Fixture rejected one local Security request.",
						},
					},
					{ status: failure.status }
				);
			}
			const headers = new Headers({ authorization: `Bearer ${token}` });
			for (const header of [
				"content-type",
				"x-ryu-caller-user-id",
				"x-ryu-caller-org-id",
			]) {
				const value = request.headers.get(header);
				if (value) {
					headers.set(header, value);
				}
			}
			const sidecarResponse = await fetch(
				`http://127.0.0.1:${sidecarPort}/api/security${apiPath}${url.search}`,
				{
					method: request.method,
					headers,
					...(request.method === "GET" || request.method === "HEAD"
						? undefined
						: { body: await request.arrayBuffer() }),
				}
			);
			return new Response(sidecarResponse.body, {
				status: sidecarResponse.status,
				headers: {
					"content-type":
						sidecarResponse.headers.get("content-type") ?? "application/json",
				},
			});
		}

		const requestedPath =
			url.pathname === "/" ? "/security-companion-proof.html" : url.pathname;
		const filePath = path.resolve(hostBuildDirectory, `.${requestedPath}`);
		if (
			!filePath.startsWith(`${path.resolve(hostBuildDirectory)}${path.sep}`)
		) {
			return new Response("Not found", { status: 404 });
		}
		const file = Bun.file(filePath);
		if (!(await file.exists())) {
			return new Response("Not found", { status: 404 });
		}
		const extension = path.extname(filePath);
		const contentType =
			extension === ".html"
				? "text/html; charset=utf-8"
				: extension === ".js"
					? "text/javascript; charset=utf-8"
					: extension === ".css"
						? "text/css; charset=utf-8"
						: "application/octet-stream";
		return new Response(file, { headers: { "content-type": contentType } });
	},
});

console.info(
	`Security proof sidecar: ${sidecarPort}; host: ${hostPort}; fixture roots: ${fixtureDirectory}`
);

const stop = async () => {
	host.stop();
	sidecarProcess.kill();
	await rm(fixtureDirectory, { force: true, recursive: true });
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
