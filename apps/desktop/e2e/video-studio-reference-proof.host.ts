import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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

async function buildReferenceVideo() {
	const directory = await mkdtemp(path.join(tmpdir(), "ryu-reference-proof-"));
	const fixturePath = path.join(directory, "reference-source.mp4");
	const render = Bun.spawn(
		[
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			"color=c=0x442255:s=320x180:r=12:d=8",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=8",
			"-map",
			"0:v:0",
			"-map",
			"1:a:0",
			"-shortest",
			"-c:v",
			"libx264",
			"-preset",
			"ultrafast",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			"-b:a",
			"48k",
			"-movflags",
			"+faststart",
			"-t",
			"8",
			"-y",
			fixturePath,
		],
		{ stderr: "inherit", stdout: "inherit" }
	);
	const exitCode = await render.exited;
	if (exitCode !== 0) {
		await rm(directory, { force: true, recursive: true });
		throw new Error(`Could not create the local reference video: ${exitCode}.`);
	}
	const bytes = Buffer.from(await Bun.file(fixturePath).arrayBuffer());
	await rm(directory, { force: true, recursive: true });
	return bytes;
}

await buildPackage(sidecarDirectory, "Video Studio sidecar");
await buildPackage(companionDirectory, "Video Studio Companion");

const videoBytes = await buildReferenceVideo();
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
		RYU_DIR: path.join(
			tmpdir(),
			`ryu-video-studio-reference-e2e-${process.pid}`
		),
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
		if (url.pathname === "/__proof/video") {
			return new Response(videoBytes, {
				headers: { "content-type": "video/mp4" },
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
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
