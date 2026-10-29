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

async function buildAudio() {
	const directory = await mkdtemp(path.join(tmpdir(), "ryu-transcript-proof-"));
	const fixturePath = path.join(directory, "spoken-source.wav");
	const render = Bun.spawn(
		[
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=24",
			"-ac",
			"1",
			"-ar",
			"8000",
			"-c:a",
			"pcm_s16le",
			"-t",
			"24",
			"-y",
			fixturePath,
		],
		{ stderr: "inherit", stdout: "inherit" }
	);
	const exitCode = await render.exited;
	if (exitCode !== 0) {
		await rm(directory, { force: true, recursive: true });
		throw new Error(
			`Could not create the local transcript audio: ${exitCode}.`
		);
	}
	const bytes = Buffer.from(await Bun.file(fixturePath).arrayBuffer());
	await rm(directory, { force: true, recursive: true });
	return bytes;
}

await buildPackage(sidecarDirectory, "Video Studio sidecar");
await buildPackage(companionDirectory, "Video Studio Companion");

const audioBytes = await buildAudio();
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
			`ryu-video-studio-transcript-e2e-${process.pid}`
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

const calls: Array<{
	audioLength: number;
	audioPrefix: string;
	detailed: boolean;
	filename: string;
}> = [];
let nextFailure: string | undefined;
let delayNext = 0;
const transcriberResult = {
	text: "Harbor lights are ahead.",
	segments: [{ startMs: 500, endMs: 1800, text: "Harbor lights are ahead." }],
	words: [
		{ startMs: 500, endMs: 850, text: "Harbor" },
		{ startMs: 880, endMs: 1120, text: "lights" },
		{ startMs: 1140, endMs: 1300, text: "are" },
		{ startMs: 1320, endMs: 1800, text: "ahead." },
	],
};

const bridge = `<script>
const studioRequest=async(input)=>{
  const response=await fetch('/__studio'+input.path,{method:input.method||'GET',headers:{'content-type':'application/json'},...(input.body===undefined?{}:{body:JSON.stringify(input.body)})});
  const result=await response.json();
  if(!response.ok)throw new Error(result.message||'Request failed');
  return result;
};
const localTranscriber=async(input)=>{
  const response=await fetch('/__proof/transcribe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
  const result=await response.json();
  if(!response.ok)throw new Error(result.message||'Local transcription fixture failed.');
  return result;
};
window.ryu={app:{request:studioRequest},media:{transcribe:localTranscriber}};
</script>`;
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
		if (url.pathname === "/__proof/audio") {
			return new Response(audioBytes, {
				headers: { "content-type": "audio/wav" },
			});
		}
		if (url.pathname === "/__proof/state") {
			return Response.json({ calls });
		}
		if (
			url.pathname === "/__proof/fail-next-transcription" &&
			request.method === "POST"
		) {
			const input = await request.json();
			nextFailure = input.message;
			return Response.json({ armed: true });
		}
		if (
			url.pathname === "/__proof/delay-next-transcription" &&
			request.method === "POST"
		) {
			const input = await request.json();
			delayNext = Math.max(0, Math.min(5000, input.milliseconds));
			return Response.json({ delayed: delayNext });
		}
		if (url.pathname === "/__proof/transcribe" && request.method === "POST") {
			const input = await request.json();
			calls.push({
				audioLength: input.audio.length,
				audioPrefix: input.audio.slice(0, 24),
				detailed: input.detailed === true,
				filename: input.filename,
			});
			if (delayNext > 0) {
				const delay = delayNext;
				delayNext = 0;
				await Bun.sleep(delay);
			}
			if (nextFailure) {
				const message = nextFailure;
				nextFailure = undefined;
				return Response.json({ message }, { status: 503 });
			}
			return Response.json(transcriberResult);
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
