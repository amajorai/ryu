import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
import { createPullRequestsProofState } from "./harness/pull-requests-companion-fixture.ts";

const desktopDirectory = path.resolve(import.meta.dirname, "..");
const repositoryDirectory = path.resolve(desktopDirectory, "../..");
const fixtureDirectory = await mkdtemp(
	path.join(tmpdir(), "ryu-pull-requests-companion-proof-")
);
const dataDirectory = path.join(fixtureDirectory, "ryu-data");
const homeDirectory = path.join(fixtureDirectory, "home");
const fakeBinDirectory = path.join(fixtureDirectory, "bin");
const statePath = path.join(fixtureDirectory, "pull-requests-proof-state.json");
const uiBuildDirectory = `${tmpdir()}/ryu-pull-requests-companion-ui-build`;
const hostBuildDirectory = `${tmpdir()}/ryu-pull-requests-companion-host-build`;
const sidecarDirectory = path.join(
	repositoryDirectory,
	"apps-store/pull-requests/sidecar"
);
const sidecarEntry = path.join(sidecarDirectory, "src/index.ts");
const fakeCliSource = await Bun.file(
	path.join(desktopDirectory, "e2e/harness/pull-requests-companion-fake-gh.mjs")
).text();
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
				reject(
					new Error("Could not reserve a local Pull Requests sidecar port.")
				);
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

await Promise.all([
	mkdir(dataDirectory, { recursive: true }),
	mkdir(homeDirectory, { recursive: true }),
	mkdir(fakeBinDirectory, { recursive: true }),
]);
const fakeGhPath = path.join(fakeBinDirectory, "gh");
await writeFile(fakeGhPath, `#!${process.execPath}\n${fakeCliSource}`, "utf8");
await chmod(fakeGhPath, 0o755);
await writeFile(
	statePath,
	JSON.stringify(createPullRequestsProofState(true), null, 2),
	"utf8"
);

// The sidecar is a standalone satellite outside the root Bun workspace, so root
// `bun install` never provisions it. Install it from its committed lockfile, as
// its satellite CI and the release build do, before spawning it.
await runRtk(["bun", "install", "--frozen-lockfile"], sidecarDirectory);
await runRtk(
	[
		"bun",
		"x",
		"vite",
		"build",
		"--config",
		"../../apps-store/pull-requests/ui/vite.config.ts",
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
		"e2e/harness/vite.pull-requests-companion-proof.config.ts",
	],
	desktopDirectory
);

const sidecarPort = await reservePort();
const sidecarProcess = spawn(process.execPath, [sidecarEntry], {
	cwd: repositoryDirectory,
	env: {
		...process.env,
		GH_TOKEN: undefined,
		GITHUB_TOKEN: undefined,
		HOME: homeDirectory,
		PATH: fakeBinDirectory,
		PULL_REQUESTS_PROOF_STATE: statePath,
		RYU_DIR: dataDirectory,
		RYU_EXT_TOKEN: token,
		RYU_KEYCHAIN: "off",
		RYU_PROFILE: "dev",
		RYU_PULL_REQUESTS_PORT: String(sidecarPort),
	},
	stdio: "inherit",
});

let sidecarReady = false;
for (let attempt = 0; attempt < 100; attempt += 1) {
	if (sidecarProcess.exitCode !== null) {
		throw new Error("The local Pull Requests sidecar exited during startup.");
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
	throw new Error("The local Pull Requests sidecar did not become healthy.");
}

const hostPort = Number(process.env.RYU_PULL_REQUESTS_PROOF_PORT ?? 5473);
const host = Bun.serve({
	hostname: "127.0.0.1",
	port: hostPort,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/__ready") {
			return Response.json({ ok: true, sidecarReady });
		}
		if (url.pathname === "/__proof/reset" && request.method === "POST") {
			const body = await request.json();
			await writeFile(
				statePath,
				JSON.stringify(
					createPullRequestsProofState(body.authenticated ?? true),
					null,
					2
				),
				"utf8"
			);
			return Response.json({ ok: true });
		}
		if (url.pathname === "/__proof/commands") {
			const state = z
				.object({
					commands: z.array(
						z.object({
							argv: z.array(z.string()),
							cwd: z.string().nullable(),
							failed: z.boolean(),
						})
					),
				})
				.passthrough()
				.parse(JSON.parse(await Bun.file(statePath).text()));
			return Response.json(state.commands);
		}
		if (url.pathname === "/__proof/state") {
			return Response.json(JSON.parse(await Bun.file(statePath).text()));
		}
		if (url.pathname === "/__proof/fail-next" && request.method === "POST") {
			const failure = z
				.object({ match: z.string(), message: z.string() })
				.parse(await request.json());
			const state = z
				.object({
					failNext: z.array(
						z.object({ match: z.string(), message: z.string() })
					),
				})
				.passthrough()
				.parse(JSON.parse(await Bun.file(statePath).text()));
			state.failNext.push(failure);
			await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
			return Response.json({ armed: true });
		}
		if (
			url.pathname === "/__proof/auth-complete" &&
			request.method === "POST"
		) {
			const state = z
				.object({ authComplete: z.boolean() })
				.passthrough()
				.parse(JSON.parse(await Bun.file(statePath).text()));
			state.authComplete = true;
			await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
			return Response.json({ completed: true });
		}
		if (url.pathname.startsWith("/__proof/pull-requests")) {
			const apiPath = url.pathname.slice("/__proof/pull-requests".length);
			const sidecarResponse = await fetch(
				`http://127.0.0.1:${sidecarPort}/api/pull-requests${apiPath}${url.search}`,
				{
					method: request.method,
					headers: {
						authorization: `Bearer ${token}`,
						...(request.headers.get("content-type")
							? { "content-type": request.headers.get("content-type")! }
							: undefined),
					},
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
			url.pathname === "/"
				? "/pull-requests-companion-proof.html"
				: url.pathname;
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
	`Pull Requests proof sidecar: ${sidecarPort}; host: ${hostPort}; fake gh state: ${statePath}`
);

const stop = async () => {
	host.stop();
	sidecarProcess.kill();
	await rm(fixtureDirectory, { force: true, recursive: true });
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
