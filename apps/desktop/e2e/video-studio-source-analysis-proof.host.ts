import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";

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
	path.join(tmpdir(), "ryu-video-studio-source-analysis-")
);

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

const audioPath = path.join(fixtureDirectory, "analysis-pulses.wav");
const videoPath = path.join(fixtureDirectory, "analysis-scene-cuts.mp4");
const ffmpegDelayPath = path.join(fixtureDirectory, "ffmpeg-delayed");
const pulseSource =
	"aevalsrc=0.5*sin(2*PI*440*t)*if(lt(mod(t\\,1)\\,0.15)\\,1\\,if(gte(mod(t\\,1)\\,0.5)*lt(mod(t\\,1)\\,0.65)\\,0.45\\,0)):s=48000:d=8";

await buildPackage(sidecarDirectory, "Video Studio sidecar");
await buildPackage(companionDirectory, "Video Studio Companion");
await run("ffmpeg", [
	"-hide_banner",
	"-loglevel",
	"error",
	"-f",
	"lavfi",
	"-i",
	pulseSource,
	"-ac",
	"1",
	"-c:a",
	"pcm_s16le",
	"-y",
	audioPath,
]);
await run("ffmpeg", [
	"-hide_banner",
	"-loglevel",
	"error",
	"-f",
	"lavfi",
	"-i",
	"color=c=0xdd3322:s=320x180:r=12:d=3",
	"-f",
	"lavfi",
	"-i",
	"color=c=0x228844:s=320x180:r=12:d=2",
	"-f",
	"lavfi",
	"-i",
	"color=c=0x2244dd:s=320x180:r=12:d=3",
	"-f",
	"lavfi",
	"-i",
	pulseSource,
	"-filter_complex",
	"[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
	"-map",
	"[v]",
	"-map",
	"3:a",
	"-c:v",
	"libx264",
	"-preset",
	"ultrafast",
	"-pix_fmt",
	"yuv420p",
	"-c:a",
	"aac",
	"-b:a",
	"64k",
	"-movflags",
	"+faststart",
	"-t",
	"8",
	"-y",
	videoPath,
]);
await writeFile(
	ffmpegDelayPath,
	"#!/usr/bin/env python3\nimport os, sys, time\ntime.sleep(1.5)\nos.execvp('ffmpeg', ['ffmpeg', *sys.argv[1:]])\n",
	{ mode: 0o700 }
);
await chmod(ffmpegDelayPath, 0o700);
const audioBytes = await readFile(audioPath);
const videoBytes = await readFile(videoPath);
const token = randomUUID();
const sidecarPort = await new Promise<number>((resolve, reject) => {
	const reservation = createServer();
	reservation.once("error", reject);
	reservation.listen(0, "127.0.0.1", () => {
		const address = reservation.address();
		if (!address || isNativeText(address)) {
			reservation.close();
			reject(new Error("Could not reserve a local Video Studio sidecar port."));
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
const server = spawn(sidecar, [], {
	env: {
		...process.env,
		RYU_EXT_TOKEN: token,
		RYU_EXT_PLUGIN_ID: "@ryu/video-studio",
		RYU_CORE_PORT: "27980",
		RYU_PROFILE: "dev",
		RYU_KEYCHAIN: "off",
		RYU_DIR: path.join(fixtureDirectory, "sidecar-data"),
		RYU_VIDEO_STUDIO_FFMPEG: ffmpegDelayPath,
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

const bridge = `<script>window.ryu={app:{request:async(input)=>{const response=await fetch('/__studio'+input.path,{method:input.method||'GET',headers:{'content-type':'application/json'},...(input.body===undefined?{}:{body:JSON.stringify(input.body)})});const result=await response.json();if(!response.ok)throw new Error(result.message||'Request failed');return result;}}};</script>`;
const html = (await Bun.file(appHtml).text()).replace(
	"<head>",
	`<head>${bridge}`
);
const host = Bun.serve({
	hostname: "127.0.0.1",
	port: 5367,
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
		if (url.pathname === "/__proof/audio") {
			return new Response(audioBytes, {
				headers: { "content-type": "audio/wav" },
			});
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
	void rm(fixtureDirectory, { force: true, recursive: true });
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
