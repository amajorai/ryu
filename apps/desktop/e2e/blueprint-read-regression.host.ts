import { tmpdir } from "node:os";
import path from "node:path";
const desktopDirectory = path.resolve(import.meta.dirname, "..");
const repositoryDirectory = path.resolve(desktopDirectory, "../..");
const hostBuildDirectory = path.join(
	tmpdir(),
	"ryu-blueprint-read-regression-host-build"
);
async function build(cwd: string, args: string[]): Promise<void> {
	const child = Bun.spawn([process.execPath, "x", "vite", "build", ...args], {
		cwd,
		stdout: "inherit",
		stderr: "inherit",
	});
	const code = await child.exited;
	if (code !== 0) {
		throw new Error(`Companion regression build failed (${code}) in ${cwd}.`);
	}
}
for (const app of ["blueprint"]) {
	await build(path.join(repositoryDirectory, "apps-store", app, "ui"), [
		"--outDir",
		path.join(tmpdir(), `ryu-blueprint-read-regression-${app}-build`),
	]);
}
await build(desktopDirectory, [
	"--config",
	"e2e/harness/vite.blueprint-read-regression.config.ts",
]);
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.RYU_BLUEPRINT_READ_PORT ?? 5526),
	async fetch(request) {
		const pathname = new URL(request.url).pathname;
		if (pathname === "/__ready") {
			return new Response("ready");
		}
		const relative =
			pathname === "/" ? "blueprint-read-regression.html" : pathname.slice(1);
		const filePath = path.resolve(hostBuildDirectory, relative);
		if (!filePath.startsWith(`${hostBuildDirectory}/`)) {
			return new Response("Forbidden", { status: 403 });
		}
		const file = Bun.file(filePath);
		return (await file.exists())
			? new Response(file)
			: new Response("Not found", { status: 404 });
	},
});
process.on("SIGTERM", () => {
	server.stop(true);
	process.exit(0);
});
