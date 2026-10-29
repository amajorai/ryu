import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

const desktopDir = path.resolve(import.meta.dirname, "..");
const repositoryDir = path.resolve(desktopDir, "../..");
const sidecarDirectory = path.join(
	repositoryDir,
	"apps-store/video-studio/sidecar"
);
const companionDirectory = path.join(
	repositoryDir,
	"apps-store/video-studio/ui"
);
const sidecar = path.join(sidecarDirectory, "dist/ryu-video-studio");
const appHtml = path.join(companionDirectory, "dist/index.html");

async function buildPackage(directory: string, name: string) {
	const build = Bun.spawn(["bun", "run", "build"], {
		cwd: directory,
		stderr: "inherit",
		stdout: "inherit",
	});
	const exitCode = await build.exited;
	if (exitCode !== 0) {
		throw new Error(`${name} build failed with exit code ${exitCode}.`);
	}
}

await buildPackage(sidecarDirectory, "Video Studio sidecar");
await buildPackage(companionDirectory, "Video Studio Companion");

const token = randomUUID();
const portReservation = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: () => new Response("reserved"),
});
const sidecarPort = portReservation.port;
portReservation.stop();
const server = spawn(sidecar, [], {
	env: {
		...process.env,
		RYU_EXT_TOKEN: token,
		RYU_EXT_PLUGIN_ID: "@ryu/video-studio",
		RYU_CORE_PORT: "27980",
		RYU_PROFILE: "dev",
		RYU_KEYCHAIN: "off",
		RYU_DIR: path.join(tmpdir(), `ryu-video-studio-stage-e2e-${process.pid}`),
		RYU_VIDEO_STUDIO_PORT: String(sidecarPort),
	},
	stdio: "inherit",
});

let ready = false;
for (let attempt = 0; attempt < 100; attempt += 1) {
	if (server.exitCode !== null) {
		throw new Error("The Video Studio sidecar exited during startup.");
	}
	ready = await fetch(
		`http://127.0.0.1:${sidecarPort}/api/video-studio/projects`,
		{
			headers: { authorization: `Bearer ${token}` },
		}
	).then(
		(response) => response.ok,
		() => false
	);
	if (ready) {
		break;
	}
	await Bun.sleep(100);
}
if (!ready) {
	server.kill();
	throw new Error(
		"The authenticated Video Studio sidecar did not become ready."
	);
}

const bridge = `<script>window.ryu={app:{request:async(input)=>{const response=await fetch('/__studio'+input.path,{method:input.method||'GET',headers:{'content-type':'application/json'},...(input.body===undefined?{}:{body:JSON.stringify(input.body)})});const result=await response.json();if(!response.ok)throw new Error(result.message||'Request failed');return result;}}};</script>`;
const html = (await Bun.file(appHtml).text()).replace(
	"<head>",
	`<head>${bridge}`
);
const host = Bun.serve({
	hostname: "127.0.0.1",
	port: 5187,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/__ready") {
			return new Response("ok");
		}
		if (url.pathname.startsWith("/__studio/")) {
			return fetch(
				`http://127.0.0.1:${sidecarPort}/api/video-studio${url.pathname.slice("/__studio".length)}${url.search}`,
				{
					method: request.method,
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${token}`,
					},
					...(["GET", "HEAD"].includes(request.method)
						? undefined
						: { body: await request.arrayBuffer() }),
				}
			);
		}
		return new Response(html, { headers: { "content-type": "text/html" } });
	},
});

const stop = () => {
	host.stop();
	server.kill();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
