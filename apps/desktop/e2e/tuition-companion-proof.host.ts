import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const desktopDirectory = path.resolve(import.meta.dirname, "..");
const appBuildDirectory = `${tmpdir()}/ryu-tuition-companion-ui-build`;
const hostBuildDirectory = `${tmpdir()}/ryu-tuition-companion-host-build`;
const hostPort = Number(process.env.RYU_TUITION_PROOF_PORT ?? 5496);

async function runRtk(args: string[], cwd: string): Promise<void> {
	// rtk only condenses output; hosts without it (CI) run the command directly.
	const executable = Bun.which("rtk");
	const build = Bun.spawn(executable ? [executable, ...args] : args, {
		cwd,
		stderr: "inherit",
		stdout: "inherit",
	});
	const exitCode = await build.exited;
	if (exitCode !== 0) {
		throw new Error(`${args.join(" ")} failed with exit code ${exitCode}.`);
	}
}

await mkdir(appBuildDirectory, { recursive: true });
await Promise.all([
	runRtk(
		[
			"bun",
			"x",
			"vite",
			"build",
			"--config",
			"../../apps-store/tuition/ui/vite.config.ts",
			"--outDir",
			appBuildDirectory,
		],
		desktopDirectory
	),
	runRtk(
		[
			"bun",
			"x",
			"vite",
			"build",
			"--config",
			"e2e/harness/vite.tuition-companion-proof.config.ts",
		],
		desktopDirectory
	),
]);

const appHtml = await readFile(
	path.join(appBuildDirectory, "index.html"),
	"utf8"
);
if (!appHtml.includes("Tuition") || appHtml.includes('src="./assets/')) {
	throw new Error(
		"The Tuition proof build must contain the compiled single-file Companion bundle."
	);
}

const host = Bun.serve({
	hostname: "127.0.0.1",
	port: hostPort,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/__ready") {
			return Response.json({ compiled: true, extensionHost: true, ok: true });
		}
		const requested = decodeURIComponent(
			url.pathname === "/" ? "/tuition-companion-proof.html" : url.pathname
		);
		const filename = path.resolve(hostBuildDirectory, `.${requested}`);
		if (
			filename === hostBuildDirectory ||
			!filename.startsWith(`${hostBuildDirectory}${path.sep}`)
		) {
			return new Response("Not found", { status: 404 });
		}
		const file = Bun.file(filename);
		if (!(await file.exists())) {
			return new Response("Not found", { status: 404 });
		}
		return new Response(file, {
			headers: {
				"cache-control": "no-store",
				"content-type": file.type || "text/html",
			},
		});
	},
});

const shutdown = async () => {
	host.stop(true);
	await rm(appBuildDirectory, { force: true, recursive: true });
	await rm(hostBuildDirectory, { force: true, recursive: true });
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
