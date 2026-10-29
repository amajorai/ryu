import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

const sitesOptionsSchema = z.object({
	agentAvailable: z.boolean(),
	answersAvailable: z.boolean(),
	approvedSpaceId: z.string(),
	edgeAvailable: z.boolean(),
	identityAvailable: z.boolean(),
	publicEnabled: z.boolean(),
	retrievalAvailable: z.boolean(),
	scannerAvailable: z.boolean(),
	scannerMode: z.enum(["pass", "unavailable"]),
});

interface SitesProofOptions {
	agentAvailable: boolean;
	answersAvailable: boolean;
	approvedSpaceId: string;
	edgeAvailable: boolean;
	identityAvailable: boolean;
	publicEnabled: boolean;
	retrievalAvailable: boolean;
	scannerAvailable: boolean;
	scannerMode: "pass" | "unavailable";
}

interface SitesProofObservations {
	answerCalls: Array<{ query: string; siteId: string; spaceId: string }>;
	resetActionCalls: Array<{
		ownerId: string;
		provider: string;
		siteId: string;
	}>;
	retrievalCalls: Array<{ query: string; siteId: string; spaceId: string }>;
	scanCalls: Array<{ digest: string; html: string; versionId?: string }>;
}

const desktopDirectory = path.resolve(import.meta.dirname, "..");
const repositoryDirectory = path.resolve(desktopDirectory, "../..");
const fixtureDirectory = await mkdtemp(
	path.join(tmpdir(), "ryu-sites-companion-proof-")
);
const dataDirectory = path.join(fixtureDirectory, "ryu-data");
const optionsPath = path.join(fixtureDirectory, "sites-proof-options.json");
const observationsPath = path.join(
	fixtureDirectory,
	"sites-proof-observations.json"
);
const uiBuildDirectory = `${tmpdir()}/ryu-sites-companion-ui-build`;
const hostBuildDirectory = `${tmpdir()}/ryu-sites-companion-host-build`;
const sidecarEntry = path.join(
	desktopDirectory,
	"e2e/harness/sites-companion-sidecar.ts"
);
const token = randomUUID();
const hostPort = Number(process.env.RYU_SITES_PROOF_PORT ?? 5488);
const defaultOptions: SitesProofOptions = {
	agentAvailable: true,
	answersAvailable: true,
	approvedSpaceId: "space-approved-proof",
	edgeAvailable: true,
	identityAvailable: true,
	publicEnabled: true,
	retrievalAvailable: true,
	scannerAvailable: true,
	scannerMode: "pass",
};
let adminPort = 0;
let visitorPort = 0;
let sidecar: Bun.Subprocess | null = null;

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
	const reservation = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(null, { status: 204 }),
	});
	const port = reservation.port;
	reservation.stop(true);
	if (port === undefined) {
		throw new Error("Could not reserve a loopback Sites sidecar port.");
	}
	return port;
}

async function writeJson<T>(filePath: string, value: T): Promise<void> {
	await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function initializeSidecarState(
	options: SitesProofOptions = defaultOptions
): Promise<void> {
	await writeJson(optionsPath, options);
	await writeJson(observationsPath, {
		answerCalls: [],
		retrievalCalls: [],
		scanCalls: [],
		resetActionCalls: [],
	} satisfies SitesProofObservations);
}

function spawnSidecar(): Bun.Subprocess {
	return Bun.spawn([process.execPath, sidecarEntry], {
		cwd: repositoryDirectory,
		env: {
			...process.env,
			GH_TOKEN: undefined,
			GITHUB_TOKEN: undefined,
			RYU_DIR: dataDirectory,
			RYU_KEYCHAIN: "off",
			RYU_PROFILE: "dev",
			RYU_SITES_PORT: String(adminPort),
			RYU_SITES_PROOF_OBSERVATIONS_FILE: observationsPath,
			RYU_SITES_PROOF_OPTIONS_FILE: optionsPath,
			RYU_SITES_TOKEN: token,
			RYU_SITES_VISITOR_PORT: String(visitorPort),
		},
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
	});
}

async function startSidecar(): Promise<void> {
	sidecar = spawnSidecar();
	for (let attempt = 0; attempt < 120; attempt += 1) {
		if (sidecar.exitCode !== null) {
			throw new Error(
				`Sites proof sidecar exited during startup with ${sidecar.exitCode}.`
			);
		}
		const ready = await fetch(`http://127.0.0.1:${adminPort}/health`).then(
			(response) => response.ok,
			() => false
		);
		const visitorReady = await fetch(
			`http://127.0.0.1:${visitorPort}/health`
		).then(
			() => true,
			() => false
		);
		if (ready && visitorReady) {
			return;
		}
		await Bun.sleep(100);
	}
	throw new Error("Sites proof sidecar did not become healthy.");
}

async function stopSidecar(): Promise<void> {
	const child = sidecar;
	sidecar = null;
	if (!child || child.exitCode !== null) {
		return;
	}
	child.kill("SIGTERM");
	await Promise.race([child.exited, Bun.sleep(5000)]);
	if (child.exitCode === null) {
		child.kill("SIGKILL");
		await child.exited;
	}
}

await Promise.all([
	mkdir(dataDirectory, { recursive: true }),
	initializeSidecarState(),
]);
adminPort = await reservePort();
visitorPort = await reservePort();

await Promise.all([
	runRtk(
		[
			"bun",
			"x",
			"vite",
			"build",
			"--config",
			"../../apps-store/sites/ui/vite.config.ts",
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
			"e2e/harness/vite.sites-companion-proof.config.ts",
		],
		desktopDirectory
	),
]);

await startSidecar();

const host = Bun.serve({
	hostname: "127.0.0.1",
	port: hostPort,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/__ready") {
			const [admin, visitor] = await Promise.all([
				fetch(`http://127.0.0.1:${adminPort}/health`).then(
					(response) => response.ok
				),
				fetch(`http://127.0.0.1:${visitorPort}/health`).then(
					() => true,
					() => false
				),
			]);
			return Response.json({ admin, visitor, ok: admin && visitor });
		}
		if (url.pathname === "/__proof/reset" && request.method === "POST") {
			const body = z
				.object({ options: sitesOptionsSchema.partial().optional() })
				.parse(await request.json().catch(() => ({})));
			await stopSidecar();
			await rm(dataDirectory, { force: true, recursive: true });
			await mkdir(dataDirectory, { recursive: true });
			await initializeSidecarState({ ...defaultOptions, ...body.options });
			await startSidecar();
			return Response.json({ ok: true });
		}
		if (url.pathname === "/__proof/restart" && request.method === "POST") {
			await stopSidecar();
			await startSidecar();
			return Response.json({ ok: true });
		}
		if (url.pathname === "/__proof/options" && request.method === "POST") {
			const patch = sitesOptionsSchema.partial().parse(await request.json());
			const options = sitesOptionsSchema.parse(
				JSON.parse(await readFile(optionsPath, "utf8"))
			);
			const next = { ...options, ...patch };
			await writeJson(optionsPath, next);
			return Response.json(next);
		}
		if (url.pathname === "/__proof/state") {
			const [projects, observations, options] = await Promise.all([
				fetch(`http://127.0.0.1:${adminPort}/api/sites/projects`, {
					headers: { authorization: `Bearer ${token}` },
				}).then((response) => response.json()),
				Bun.file(observationsPath).json(),
				Bun.file(optionsPath).json(),
			]);
			return Response.json({ observations, options, projects });
		}
		if (url.pathname.startsWith("/__proof/sites")) {
			const sidecarPath = url.pathname.slice("/__proof/sites".length) || "/";
			const target = `http://127.0.0.1:${adminPort}/api/sites${sidecarPath}${url.search}`;
			const headers = new Headers({ authorization: `Bearer ${token}` });
			const contentType = request.headers.get("content-type");
			if (contentType) {
				headers.set("content-type", contentType);
			}
			const response = await fetch(target, {
				method: request.method,
				headers,
				...(request.method === "GET" || request.method === "HEAD"
					? undefined
					: { body: await request.arrayBuffer() }),
			});
			return new Response(await response.arrayBuffer(), {
				status: response.status,
				headers: {
					"cache-control": "no-store",
					"content-type":
						response.headers.get("content-type") ?? "application/json",
				},
			});
		}
		const requested = decodeURIComponent(
			url.pathname === "/" ? "/sites-companion-proof.html" : url.pathname
		);
		const filename = path.resolve(hostBuildDirectory, `.${requested}`);
		if (
			filename !== hostBuildDirectory &&
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
	await stopSidecar();
	await rm(fixtureDirectory, { force: true, recursive: true });
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

// Useful in the Playwright webServer log when diagnosing an isolated startup failure.
if (process.env.RYU_SITES_PROOF_DEBUG === "1") {
	console.info(
		`Sites proof host ${host.url}; isolated SQLite at ${dataDirectory}`
	);
}
