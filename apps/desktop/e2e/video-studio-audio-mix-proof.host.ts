import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
const fixtureDirectory = await mkdtemp(
	path.join(tmpdir(), "ryu-video-studio-audio-mix-proof-")
);
const videoPath = path.join(fixtureDirectory, "sync-reference.mp4");

async function run(command: string, args: string[], cwd?: string) {
	const child = Bun.spawn([command, ...args], {
		...(cwd ? { cwd } : undefined),
		stderr: "inherit",
		stdout: "inherit",
	});
	const exitCode = await child.exited;
	if (exitCode !== 0) {
		throw new Error(`${command} ${args[0] ?? ""} exited with ${exitCode}.`);
	}
}

async function buildPackage(directory: string, name: string) {
	await run("bun", ["run", "build"], directory).catch((error) => {
		throw new Error(`${name} build failed.`, { cause: error });
	});
}

await buildPackage(sidecarDirectory, "Video Studio sidecar");
await buildPackage(companionDirectory, "Video Studio Companion");
await run("ffmpeg", [
	"-hide_banner",
	"-loglevel",
	"error",
	"-f",
	"lavfi",
	"-i",
	"color=c=0x315a83:s=640x360:r=24:d=8",
	"-f",
	"lavfi",
	"-i",
	"sine=frequency=440:duration=8",
	"-map",
	"0:v:0",
	"-map",
	"1:a:0",
	"-c:v",
	"libx264",
	"-preset",
	"ultrafast",
	"-pix_fmt",
	"yuv420p",
	"-c:a",
	"aac",
	"-b:a",
	"96k",
	"-movflags",
	"+faststart",
	"-shortest",
	"-t",
	"8",
	"-y",
	videoPath,
]);
const videoBytes = await readFile(videoPath);
const token = randomUUID();
const sidecarPort = 57_271;
const server = spawn(sidecar, [], {
	env: {
		...process.env,
		RYU_EXT_TOKEN: token,
		RYU_EXT_PLUGIN_ID: "@ryu/video-studio",
		RYU_CORE_PORT: "27980",
		RYU_PROFILE: "dev",
		RYU_KEYCHAIN: "off",
		RYU_DIR: path.join(fixtureDirectory, "sidecar-data"),
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
		{ headers: { authorization: `Bearer ${token}` } }
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
	await rm(fixtureDirectory, { force: true, recursive: true });
	throw new Error(
		"The authenticated Video Studio sidecar did not become ready."
	);
}

let failNextSoundtrack = false;
let failNextSync = false;
const bridge = `<script>
const studioRequest=async(input)=>{
  const response=await fetch('/__studio'+input.path,{method:input.method||'GET',headers:{'content-type':'application/json'},...(input.body===undefined?{}:{body:JSON.stringify(input.body)})});
  const result=await response.json();
  if(!response.ok)throw new Error(result.message||'Request failed');
  return result;
};
window.ryu={app:{request:studioRequest}};
</script>`;
const html = (await Bun.file(appHtml).text()).replace(
	"<head>",
	`<head>${bridge}`
);
const host = Bun.serve({
	hostname: "127.0.0.1",
	port: 5404,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/__ready") {
			return new Response("ok");
		}
		if (url.pathname === "/__proof/video") {
			return new Response(videoBytes, {
				headers: { "content-type": "video/mp4" },
			});
		}
		if (
			url.pathname === "/__proof/fail-next-soundtrack" &&
			request.method === "POST"
		) {
			failNextSoundtrack = true;
			return Response.json({ armed: true });
		}
		if (
			url.pathname === "/__proof/fail-next-sync" &&
			request.method === "POST"
		) {
			failNextSync = true;
			return Response.json({ armed: true });
		}
		if (url.pathname.startsWith("/__studio/")) {
			const method = request.method;
			const body = ["GET", "HEAD"].includes(method)
				? undefined
				: await request.arrayBuffer();
			if (
				failNextSoundtrack &&
				method === "POST" &&
				url.pathname === "/__studio/soundtrack"
			) {
				failNextSoundtrack = false;
				return Response.json(
					{
						error: "fixture_soundtrack_failed",
						message: "Fixture soundtrack request failed once.",
					},
					{ status: 503 }
				);
			}
			if (
				failNextSync &&
				method === "POST" &&
				/^\/__studio\/projects\/[^/]+\/sync$/.test(url.pathname)
			) {
				failNextSync = false;
				return Response.json(
					{
						error: "fixture_sync_failed",
						message: "Fixture clip sync failed once.",
					},
					{ status: 503 }
				);
			}
			return fetch(
				`http://127.0.0.1:${sidecarPort}/api/video-studio${url.pathname.slice("/__studio".length)}${url.search}`,
				{
					method,
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${token}`,
					},
					...(body === undefined ? undefined : { body }),
				}
			);
		}
		return new Response(html, { headers: { "content-type": "text/html" } });
	},
});

const stop = () => {
	host.stop();
	server.kill();
	void rm(fixtureDirectory, { force: true, recursive: true });
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
