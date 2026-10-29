import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";

const desktopDirectory = path.resolve(import.meta.dirname, "..");
const repositoryDirectory = path.resolve(desktopDirectory, "../..");
const sidecarBinary = path.join(repositoryDirectory, "target/debug/ryu-checks");
const uiBuildDirectory = `${tmpdir()}/ryu-checks-companion-ui-build`;
const hostBuildDirectory = `${tmpdir()}/ryu-checks-companion-host-build`;
const fixtureDirectory = await mkdtemp(
	path.join(tmpdir(), "ryu-checks-companion-proof-")
);
const dataDirectory = path.join(fixtureDirectory, "ryu-data");
const token = randomUUID();
const targetRequests: Array<{ method: string; path: string }> = [];

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
				reject(new Error("Could not reserve a local Checks sidecar port."));
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

await runRtk(
	["cargo", "build", "--offline", "-p", "ryu-checks"],
	repositoryDirectory
);
await runRtk(
	[
		"bun",
		"x",
		"vite",
		"build",
		"--config",
		"../../apps-store/checks/ui/vite.config.ts",
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
		"e2e/harness/vite.checks-companion-proof.config.ts",
	],
	desktopDirectory
);

const sidecarPort = await reservePort();
const hostPort = Number(process.env.RYU_CHECKS_PROOF_PORT ?? 5461);
const sidecarProcess = spawn(sidecarBinary, [], {
	env: {
		...process.env,
		RYU_EXT_TOKEN: token,
		RYU_PROFILE: "dev",
		RYU_KEYCHAIN: "off",
		RYU_DIR: dataDirectory,
		RYU_CHECKS_PORT: String(sidecarPort),
		// Recurring schedules need Core's deferred execution authority; this host
		// answers the sidecar's host RPC below as the node-local Core would.
		RYU_CORE_PORT: String(hostPort),
		RYU_MANAGED_NODE: "0",
		RUST_LOG: "warn",
	},
	stdio: "inherit",
});

let sidecarReady = false;
for (let attempt = 0; attempt < 120; attempt += 1) {
	if (sidecarProcess.exitCode !== null) {
		throw new Error("The local ryu-checks sidecar exited during startup.");
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
	throw new Error("The local ryu-checks sidecar did not become healthy.");
}

let failNext: { method: string; path: string; status: number } | null = null;

// Core signs and verifies these proofs in production. The fixture keeps the
// same contract shape: an execution proof is only issued for a principal proof
// from the proxied caller and only for the Checks run permission.
const FIXTURE_PRINCIPAL = "fixture-principal";
const FIXTURE_EXECUTION = "fixture-execution";

function fixtureProof(kind: string, userId: string, orgId: string): string {
	return [kind, encodeURIComponent(userId), encodeURIComponent(orgId)].join(
		":"
	);
}

function fixtureSubject(
	proof: unknown,
	kind: string
): { orgId: string | null; userId: string } | null {
	if (typeof proof !== "string") {
		return null;
	}
	const [proofKind, userId, orgId, ...rest] = proof.split(":");
	if (proofKind !== kind || !userId || orgId === undefined || rest.length) {
		return null;
	}
	return {
		orgId: orgId ? decodeURIComponent(orgId) : null,
		userId: decodeURIComponent(userId),
	};
}

async function coreHostRpc(request: Request): Promise<Response> {
	if (
		request.headers.get("authorization") !== `Bearer ${token}` ||
		request.headers.get("x-ryu-plugin-id") !== "@ryu/checks"
	) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}
	const body: unknown = await request.json().catch(() => null);
	const method =
		body && typeof body === "object" && "method" in body ? body.method : null;
	const args =
		body && typeof body === "object" && "args" in body ? body.args : null;
	const field = (name: string): unknown =>
		args && typeof args === "object" && name in args
			? Reflect.get(args, name)
			: null;
	if (
		field("permission") !== "checks.run" ||
		field("resource") !== "@ryu/checks"
	) {
		return Response.json({ error: "permission denied" }, { status: 403 });
	}
	const issue = method === "authorization.issue";
	if (!(issue || method === "authorization.check")) {
		return Response.json({ error: "unsupported method" }, { status: 404 });
	}
	const subject = fixtureSubject(
		field("proof"),
		issue ? FIXTURE_PRINCIPAL : FIXTURE_EXECUTION
	);
	if (!subject) {
		return Response.json({ error: "invalid proof" }, { status: 403 });
	}
	return Response.json({
		result: issue
			? {
					orgId: subject.orgId,
					proof: fixtureProof(
						FIXTURE_EXECUTION,
						subject.userId,
						subject.orgId ?? ""
					),
					userId: subject.userId,
				}
			: { allowed: true, orgId: subject.orgId, userId: subject.userId },
	});
}

const host = Bun.serve({
	hostname: "127.0.0.1",
	port: hostPort,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/__ready") {
			return Response.json({ ok: true, sidecarReady });
		}
		if (url.pathname === "/api/host/rpc" && request.method === "POST") {
			return await coreHostRpc(request);
		}
		if (url.pathname.startsWith("/api/host/")) {
			// No other Core host capability (such as browser.control) is granted.
			return Response.json(
				{ error: "capability not granted" },
				{ status: 403 }
			);
		}
		if (url.pathname === "/__proof/fixtures") {
			return Response.json({
				projectUrl: `http://127.0.0.1:${hostPort}`,
			});
		}
		if (url.pathname === "/__proof/target-requests") {
			return Response.json(targetRequests);
		}
		if (
			url.pathname === "/__proof/clear-target-requests" &&
			request.method === "POST"
		) {
			targetRequests.length = 0;
			return Response.json({ cleared: true });
		}
		if (url.pathname.startsWith("/__proof/checks")) {
			const apiPath = url.pathname.slice("/__proof/checks".length);
			if (failNext?.method === request.method && failNext.path === apiPath) {
				const failure = failNext;
				failNext = null;
				return Response.json(
					{
						error: {
							code: "fixture_failure",
							message: "Fixture rejected one local Checks request.",
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
			const callerUserId = request.headers.get("x-ryu-caller-user-id");
			if (callerUserId) {
				// Core attaches a principal proof for the verified proxied caller.
				headers.set(
					"x-ryu-caller-principal-proof",
					fixtureProof(
						FIXTURE_PRINCIPAL,
						callerUserId,
						request.headers.get("x-ryu-caller-org-id") ?? ""
					)
				);
			}
			const sidecarResponse = await fetch(
				`http://127.0.0.1:${sidecarPort}/api/checks${apiPath}${url.search}`,
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
		if (url.pathname === "/__proof/fail-next" && request.method === "POST") {
			failNext = await request.json();
			return Response.json({ armed: true });
		}

		if (url.pathname === "/" || url.pathname.startsWith("/api/")) {
			targetRequests.push({
				method: request.method,
				path: `${url.pathname}${url.search}`,
			});
			if (url.pathname === "/") {
				return new Response(
					"<!doctype html><html><head><title>Checks Local Fixture</title></head><body><h1>Local fixture target</h1><p>Sign in, authentication, search, checkout, billing, dashboard, workspace, health, ok</p></body></html>",
					{ headers: { "content-type": "text/html; charset=utf-8" } }
				);
			}
			if (url.pathname === "/api/health") {
				return Response.json({
					features: "sign search checkout dashboard workspace",
					message: "ok",
					service: "Checks Local Fixture",
					status: "healthy",
				});
			}
			if (url.pathname === "/api/fail") {
				return Response.json(
					{ error: "fixture failure", status: "unavailable" },
					{ status: 503 }
				);
			}
			if (url.pathname === "/api/created") {
				return Response.json(
					{ id: "fixture-created", message: "ok" },
					{ status: 201 }
				);
			}
			if (url.pathname === "/api/slow") {
				await Bun.sleep(40);
				return Response.json({ message: "ok" });
			}
			return Response.json({ error: "not found" }, { status: 404 });
		}

		const requestedPath =
			url.pathname === "/" ? "/checks-companion-proof.html" : url.pathname;
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
	`Checks proof sidecar: ${sidecarPort}; host and target: ${hostPort}; fixture data: ${fixtureDirectory}`
);

const stop = async () => {
	host.stop();
	sidecarProcess.kill();
	await rm(fixtureDirectory, { force: true, recursive: true });
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
