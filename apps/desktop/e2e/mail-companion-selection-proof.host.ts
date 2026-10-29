import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const desktopDirectory = path.resolve(import.meta.dirname, "..");
const uiBuildDirectory = `${tmpdir()}/ryu-mail-inbox-selection-ui-build`;
const hostBuildDirectory = `${tmpdir()}/ryu-mail-inbox-selection-host-build`;
const hostPort = Number(process.env.RYU_MAIL_PROOF_PORT ?? 5494);

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

await mkdir(uiBuildDirectory, { recursive: true });
await Promise.all([
	runRtk(
		[
			"bun",
			"x",
			"vite",
			"build",
			"--config",
			"../../apps-store/mail/ui/vite.config.ts",
			"--outDir",
			uiBuildDirectory,
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
			"e2e/harness/vite.mail-companion-proof.config.ts",
			"--outDir",
			hostBuildDirectory,
		],
		desktopDirectory
	),
]);

const appHtml = await readFile(
	path.join(uiBuildDirectory, "index.html"),
	"utf8"
);
if (!appHtml.includes("Agent Inboxes") || appHtml.includes('src="./assets/')) {
	throw new Error(
		"Mail Companion build is missing its inline production app bundle."
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
		if (url.pathname.startsWith("/__mail-proof/download/")) {
			const attachment = url.pathname.split("/").at(-1) ?? "fixture";
			return new Response(`Local attachment fixture: ${attachment}\n`, {
				headers: {
					"content-disposition": `attachment; filename="${attachment}.txt"`,
					"content-type": "text/plain; charset=utf-8",
				},
			});
		}
		const requested = decodeURIComponent(
			url.pathname === "/" ? "/mail-companion-proof.html" : url.pathname
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
	await rm(uiBuildDirectory, { force: true, recursive: true });
	await rm(hostBuildDirectory, { force: true, recursive: true });
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

if (process.env.RYU_MAIL_PROOF_DEBUG === "1") {
	console.info(
		`Mail proof host ${host.url}; compiled Mail bundle ${appHtml.length} bytes.`
	);
}
