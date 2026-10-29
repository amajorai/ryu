import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

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
	path.join(tmpdir(), "ryu-video-studio-app-surface-proof-")
);
const importRoot = path.join(fixtureDirectory, "import-root");
const binDirectory = path.join(fixtureDirectory, "bin");
const videoPath = path.join(fixtureDirectory, "fixture-video.mp4");
const imagePath = path.join(fixtureDirectory, "fixture-image.png");
const renderDelayFlag = path.join(fixtureDirectory, "delay-next-render");
const renderActiveFlag = path.join(fixtureDirectory, "delayed-render-active");
const ffmpegPath = Bun.which("ffmpeg");
const ffprobePath = Bun.which("ffprobe");
if (!(ffmpegPath && ffprobePath)) {
	throw new Error("Video Studio proof requires local FFmpeg and ffprobe.");
}

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
await mkdir(importRoot, { recursive: true });
await mkdir(binDirectory, { recursive: true });
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
	"-c:a",
	"libopus",
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
await run("ffmpeg", [
	"-hide_banner",
	"-loglevel",
	"error",
	"-f",
	"lavfi",
	"-i",
	"color=c=0x47a3a7:s=320x180:d=0.1",
	"-frames:v",
	"1",
	"-y",
	imagePath,
]);
const videoBytes = await readFile(videoPath);
const imageBytes = await readFile(imagePath);
const imageDataUrl = `data:image/png;base64,${imageBytes.toString("base64")}`;
const token = randomUUID();
const sidecarPort = 57_311;
const wrapperPath = path.join(binDirectory, "ryu-video-studio-ffmpeg");
const renderWrapper = `#!/bin/sh
if [ -f ${JSON.stringify(renderDelayFlag)} ]; then
  rm -f ${JSON.stringify(renderDelayFlag)}
  touch ${JSON.stringify(renderActiveFlag)}
  exec sleep 30
fi
exec ${JSON.stringify(ffmpegPath)} "$@"
`;
await writeFile(wrapperPath, renderWrapper, { mode: 0o700 });
await chmod(wrapperPath, 0o700);

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
		RYU_VIDEO_STUDIO_IMPORT_ROOT: importRoot,
		RYU_VIDEO_STUDIO_FFMPEG: wrapperPath,
		RYU_VIDEO_STUDIO_FFPROBE: ffprobePath,
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

let failNextRemoteImport = false;
let failNextImageGeneration = false;
const bridge = `<script>
window.__videoStudioFixtureImageCalls=[];
const studioRequest=async(input)=>{
  const response=await fetch('/__studio'+input.path,{method:input.method||'GET',headers:{'content-type':'application/json'},...(input.body===undefined?{}:{body:JSON.stringify(input.body)})});
  const result=await response.json();
  if(!response.ok)throw new Error(result.message||'Request failed');
  return result;
};
const imageGenerator=async(input)=>{
  window.__videoStudioFixtureImageCalls.push(input);
  const failure=await fetch('/__proof/take-image-failure',{method:'POST'}).then((response)=>response.json());
  if(failure.fail)throw new Error('Fixture image generation failed once.');
  return ${JSON.stringify(imageDataUrl)};
};
window.ryu={app:{request:studioRequest},media:{image:imageGenerator}};
</script>`;
const html = (await Bun.file(appHtml).text()).replace(
	"<head>",
	`<head>${bridge}`
);
const host = Bun.serve({
	hostname: "127.0.0.1",
	port: 5406,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/__ready") {
			return new Response("ok");
		}
		if (url.pathname === "/__proof/render-active") {
			return Response.json({
				active: await Bun.file(renderActiveFlag).exists(),
			});
		}
		if (url.pathname === "/__proof/video") {
			return new Response(videoBytes, {
				headers: { "content-type": "video/mp4" },
			});
		}
		if (url.pathname === "/__proof/image") {
			return new Response(imageBytes, {
				headers: { "content-type": "image/png" },
			});
		}
		if (
			url.pathname === "/__proof/fail-next-remote-import" &&
			request.method === "POST"
		) {
			failNextRemoteImport = true;
			return Response.json({ armed: true });
		}
		if (
			url.pathname === "/__proof/fail-next-image-generation" &&
			request.method === "POST"
		) {
			failNextImageGeneration = true;
			return Response.json({ armed: true });
		}
		if (
			url.pathname === "/__proof/take-image-failure" &&
			request.method === "POST"
		) {
			const fail = failNextImageGeneration;
			failNextImageGeneration = false;
			return Response.json({ fail });
		}
		if (
			url.pathname === "/__proof/arm-render-delay" &&
			request.method === "POST"
		) {
			await writeFile(renderDelayFlag, "armed");
			return Response.json({ armed: true });
		}
		if (url.pathname.startsWith("/__studio/")) {
			const method = request.method;
			const rawBody = ["GET", "HEAD"].includes(method)
				? undefined
				: await request.arrayBuffer();
			if (
				failNextRemoteImport &&
				method === "POST" &&
				url.pathname === "/__studio/assets/import"
			) {
				failNextRemoteImport = false;
				return Response.json(
					{
						error: "fixture_remote_import_failed",
						message: "Fixture media URL import failed once.",
					},
					{ status: 503 }
				);
			}
			if (
				method === "POST" &&
				url.pathname === "/__studio/assets/import" &&
				rawBody
			) {
				const input = z
					.object({
						name: z.string().optional(),
						source: z.object({ url: z.string().optional() }),
					})
					.parse(JSON.parse(new TextDecoder().decode(rawBody)));
				if (input.source.url?.startsWith("https://media.fixture.test/")) {
					const pathname = new URL(input.source.url).pathname;
					return fetch(
						`http://127.0.0.1:${sidecarPort}/api/video-studio/assets/import`,
						{
							method: "POST",
							headers: {
								"content-type": "application/json",
								authorization: `Bearer ${token}`,
							},
							body: JSON.stringify({
								folder: "Field footage",
								name: input.name ?? pathname.split("/").at(-1),
								source: {
									bytes: Buffer.from(videoBytes).toString("base64"),
									mimeType: "video/mp4",
								},
							}),
						}
					);
				}
			}
			return fetch(
				`http://127.0.0.1:${sidecarPort}/api/video-studio${url.pathname.slice("/__studio".length)}${url.search}`,
				{
					method,
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${token}`,
					},
					...(rawBody === undefined ? undefined : { body: rawBody }),
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
