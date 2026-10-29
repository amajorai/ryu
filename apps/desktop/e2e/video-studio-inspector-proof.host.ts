import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
	path.join(tmpdir(), "ryu-video-studio-inspector-proof-")
);
const videoPath = path.join(fixtureDirectory, "inspector-video.mp4");
const audioPath = path.join(fixtureDirectory, "inspector-audio.wav");

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
	"-vf",
	"drawbox=x=mod(t*48\\,480):y=128:w=160:h=104:color=0xf4b544:t=fill",
	// VP9/Opus in MP4 decodes in Playwright's Chromium, which (unlike Chrome
	// and the desktop webviews) ships without the proprietary H.264/AAC codecs.
	"-c:v",
	"libvpx-vp9",
	"-deadline",
	"realtime",
	"-cpu-used",
	"8",
	"-b:v",
	"0",
	"-crf",
	"40",
	"-pix_fmt",
	"yuv420p",
	"-movflags",
	"+faststart",
	"-t",
	"8",
	"-y",
	videoPath,
]);
await run("ffmpeg", [
	"-hide_banner",
	"-loglevel",
	"error",
	"-f",
	"lavfi",
	"-i",
	"sine=frequency=440:duration=8",
	"-ac",
	"1",
	"-ar",
	"48000",
	"-c:a",
	"pcm_s16le",
	"-t",
	"8",
	"-y",
	audioPath,
]);
const videoBytes = await readFile(videoPath);
const audioBytes = await readFile(audioPath);
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

let failNextProjectSave = false;
const bridge = `<script>window.ryu={app:{request:async(input)=>{const response=await fetch('/__studio'+input.path,{method:input.method||'GET',headers:{'content-type':'application/json'},...(input.body===undefined?{}:{body:JSON.stringify(input.body)})});const result=await response.json();if(!response.ok)throw new Error(result.message||'Request failed');return result;}}};</script>`;
const html = (await Bun.file(appHtml).text()).replace(
	"<head>",
	`<head>${bridge}`
);
const host = Bun.serve({
	hostname: "127.0.0.1",
	port: 5394,
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
		if (
			url.pathname === "/__proof/fail-next-project-save" &&
			request.method === "POST"
		) {
			failNextProjectSave = true;
			return Response.json({ armed: true });
		}
		if (url.pathname.startsWith("/__studio/")) {
			const method = request.method;
			const body = ["GET", "HEAD"].includes(method)
				? undefined
				: await request.arrayBuffer();
			if (
				failNextProjectSave &&
				method === "PUT" &&
				/^\/__studio\/projects\/[^/]+$/.test(url.pathname)
			) {
				failNextProjectSave = false;
				return Response.json(
					{
						error: "fixture_save_failed",
						message: "Fixture project save failed.",
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
					...(body ? { body } : undefined),
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
