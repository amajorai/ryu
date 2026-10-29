import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
interface GatewayAcpSettings {
	idle_timeout_minutes: number;
	max_parallel_agents: number | null;
	keep_computer_awake: boolean;
}

const desktopDirectory = path.resolve(import.meta.dirname, "..");
const buildDirectory = path.join(
	tmpdir(),
	"ryu-acp-runtime-settings-proof-build"
);
const stateFile = path.join(
	tmpdir(),
	"ryu-acp-runtime-settings-proof-state.json"
);
const initialSettings: GatewayAcpSettings = {
	idle_timeout_minutes: 10,
	max_parallel_agents: null,
	keep_computer_awake: true,
};
interface Call {
	method: "GET" | "PUT";
	path: string;
	authorization: string | null;
	contentType: string | null;
	body: { acp: GatewayAcpSettings } | null;
	status: "pending" | "accepted" | "refused";
}
const calls: Call[] = [];
const unexpected: { method: string; path: string; reason: string }[] = [];
let holdNextWrite = false;
let refuseNextRead = false;
let releaseWrite: ((accept: boolean) => void) | null = null;

async function persist(settings: GatewayAcpSettings): Promise<void> {
	const temporary = `${stateFile}.pending`;
	await Bun.write(temporary, JSON.stringify(settings));
	await rename(temporary, stateFile);
}
await persist(initialSettings);
const build = Bun.spawn(
	[
		process.execPath,
		"x",
		"vite",
		"build",
		"--config",
		"e2e/harness/vite.acp-runtime-proof.config.ts",
	],
	{ cwd: desktopDirectory, stdout: "inherit", stderr: "inherit" }
);
if ((await build.exited) !== 0) {
	throw new Error("ACP production settings harness build failed.");
}
const json = (data: unknown, status = 200) => Response.json(data, { status });
const saved = async () =>
	(await Bun.file(stateFile).json()) as GatewayAcpSettings;
function validateSettings(value: unknown): value is GatewayAcpSettings {
	if (!value || typeof value !== "object") return false;
	const settings = value as GatewayAcpSettings;
	return (
		Object.keys(settings).sort().join(",") ===
			"idle_timeout_minutes,keep_computer_awake,max_parallel_agents" &&
		Number.isInteger(settings.idle_timeout_minutes) &&
		settings.idle_timeout_minutes >= 1 &&
		settings.idle_timeout_minutes <= 1440 &&
		(settings.max_parallel_agents === null ||
			(Number.isInteger(settings.max_parallel_agents) &&
				settings.max_parallel_agents >= 1 &&
				settings.max_parallel_agents <= 32)) &&
		typeof settings.keep_computer_awake === "boolean"
	);
}
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.RYU_ACP_RUNTIME_PROOF_PORT ?? 5554),
	async fetch(request) {
		const url = new URL(request.url);
		const route = url.pathname;
		if (route === "/__ready") return new Response("ready");
		if (route === "/__acp-proof/state" || route === "/__acp-proof/control") {
			if (request.headers.get("x-acp-proof-control") !== "finite-acp-fixture") {
				return json({ error: "Fixture control credential required." }, 403);
			}
			if (route.endsWith("/state") && request.method === "GET") {
				return json({
					saved: await saved(),
					calls: structuredClone(calls),
					heldWrite: releaseWrite !== null,
					unexpected: structuredClone(unexpected),
				});
			}
			if (route.endsWith("/control") && request.method === "POST") {
				const command = (await request.json()) as {
					action: string;
					accept?: boolean;
				};
				if (command.action === "reset" && !releaseWrite) {
					await persist(initialSettings);
					calls.length = 0;
					unexpected.length = 0;
					holdNextWrite = false;
					refuseNextRead = false;
				} else if (
					command.action === "hold_next_write" &&
					!holdNextWrite &&
					!releaseWrite
				) {
					holdNextWrite = true;
				} else if (
					command.action === "release_write" &&
					releaseWrite &&
					typeof command.accept === "boolean"
				) {
					releaseWrite(command.accept);
				} else if (command.action === "refuse_next_read" && !refuseNextRead) {
					refuseNextRead = true;
				} else {
					return json(
						{ error: "Unexpected finite fixture control transition." },
						409
					);
				}
				return json({ ok: true });
			}
			return json({ error: "Unexpected fixture control method." }, 405);
		}
		if (route === "/api/gateway/config") {
			const authorization = request.headers.get("authorization");
			const contentType = request.headers.get("content-type");
			if (
				authorization !== "Bearer acp-runtime-proof-node-token" ||
				contentType !== "application/json"
			) {
				unexpected.push({
					method: request.method,
					path: route,
					reason: "Wrong target authority or JSON transport",
				});
				return json(
					{ error: "Unexpected ACP target authority or JSON transport." },
					403
				);
			}
			if (request.method === "GET") {
				const call: Call = {
					method: "GET",
					path: route,
					authorization,
					contentType,
					body: null,
					status: "accepted",
				};
				calls.push(call);
				if (refuseNextRead) {
					refuseNextRead = false;
					call.status = "refused";
					return json({ error: "ACP settings read refused by fixture." }, 503);
				}
				const settings = await saved();
				return json({
					acp: {
						...settings,
						active_agents: 1,
						auto_max_parallel_agents: 2,
						effective_max_parallel_agents: settings.max_parallel_agents ?? 2,
						hardware: {
							cpu_cores: 8,
							physical_cores: 4,
							total_ram_bytes: 32 * 1024 ** 3,
						},
					},
				});
			}
			if (request.method === "PUT") {
				const body = (await request.json()) as { acp?: unknown };
				if (
					Object.keys(body).join(",") !== "acp" ||
					!validateSettings(body.acp)
				) {
					unexpected.push({
						method: request.method,
						path: route,
						reason: "Wrong ACP write shape or persisted values",
					});
					return json(
						{ error: "Unexpected ACP write shape or persisted values." },
						400
					);
				}
				const call: Call = {
					method: "PUT",
					path: route,
					authorization,
					contentType,
					body: structuredClone(body) as { acp: GatewayAcpSettings },
					status: "pending",
				};
				calls.push(call);
				if (holdNextWrite) {
					holdNextWrite = false;
					const accept = await new Promise<boolean>((resolve) => {
						releaseWrite = resolve;
					});
					releaseWrite = null;
					if (!accept) {
						call.status = "refused";
						return json(
							{ error: "ACP settings write refused by fixture." },
							503
						);
					}
				}
				await persist(body.acp);
				call.status = "accepted";
				return json({ ok: true });
			}
			unexpected.push({
				method: request.method,
				path: route,
				reason: "Unsupported ACP method",
			});
			return json({ error: "Unexpected ACP method." }, 405);
		}
		if (request.method !== "GET" || route.startsWith("/api/")) {
			unexpected.push({
				method: request.method,
				path: route,
				reason: "Unsupported API route or static method",
			});
			return json({ error: "Unexpected fixture route." }, 404);
		}
		const relative =
			route === "/" ? "acp-runtime-settings-proof.html" : route.slice(1);
		const filePath = path.resolve(buildDirectory, relative);
		if (!filePath.startsWith(`${buildDirectory}/`))
			return new Response("Forbidden", { status: 403 });
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
