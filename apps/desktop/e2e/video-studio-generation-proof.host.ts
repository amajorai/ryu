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
const imageDataUrl =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC";

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

function wavDataUrl() {
	const sampleRate = 8000;
	const frameCount = sampleRate / 2;
	const dataSize = frameCount * 2;
	const wav = Buffer.alloc(44 + dataSize);
	wav.write("RIFF", 0);
	wav.writeUInt32LE(36 + dataSize, 4);
	wav.write("WAVE", 8);
	wav.write("fmt ", 12);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(1, 22);
	wav.writeUInt32LE(sampleRate, 24);
	wav.writeUInt32LE(sampleRate * 2, 28);
	wav.writeUInt16LE(2, 32);
	wav.writeUInt16LE(16, 34);
	wav.write("data", 36);
	wav.writeUInt32LE(dataSize, 40);
	for (let frame = 0; frame < frameCount; frame += 1) {
		wav.writeInt16LE(
			Math.round(Math.sin((2 * Math.PI * 440 * frame) / sampleRate) * 1800),
			44 + frame * 2
		);
	}
	return `data:audio/wav;base64,${wav.toString("base64")}`;
}

async function videoDataUrl() {
	const directory = await mkdtemp(
		path.join(tmpdir(), "ryu-studio-generation-")
	);
	const fixturePath = path.join(directory, "local-generation-fixture.mp4");
	const render = Bun.spawn(
		[
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			"color=c=0x234567:s=64x64:r=2:d=1",
			"-an",
			"-c:v",
			"mpeg4",
			"-q:v",
			"5",
			"-t",
			"1",
			"-y",
			fixturePath,
		],
		{ stderr: "inherit", stdout: "inherit" }
	);
	const exitCode = await render.exited;
	if (exitCode !== 0) {
		await rm(directory, { force: true, recursive: true });
		throw new Error(`Could not create the local video fixture: ${exitCode}.`);
	}
	const bytes = Buffer.from(await Bun.file(fixturePath).arrayBuffer());
	await rm(directory, { force: true, recursive: true });
	return `data:video/mp4;base64,${bytes.toString("base64")}`;
}

await buildPackage(sidecarDirectory, "Video Studio sidecar");
await buildPackage(companionDirectory, "Video Studio Companion");

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
			`ryu-video-studio-generation-e2e-${process.pid}`
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

const mediaCalls: Array<{ input: unknown; kind: string }> = [];
const failedCalls = new Map<string, string>();
const videoFixture = await videoDataUrl();
const outputByKind = new Map([
	["image", imageDataUrl],
	["audio", wavDataUrl()],
	["video", videoFixture],
]);
const bridge = `<script>
window.__generationProofCalls=[];
const callFixtureMedia=async(kind,input)=>{
  const response=await fetch('/__proof/media',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind,input})});
  const result=await response.json();
  if(!response.ok)throw new Error(result.message||'Fixture media generation failed.');
  return result.url;
};
window.ryu={
  app:{request:async(input)=>{
    const response=await fetch('/__studio'+input.path,{method:input.method||'GET',headers:{'content-type':'application/json'},...(input.body===undefined?{}:{body:JSON.stringify(input.body)})});
    const result=await response.json();
    if(!response.ok)throw new Error(result.message||'Request failed');
    return result;
  }},
  media:{
    image:async(input)=>callFixtureMedia('image',input),
    video:async(input)=>callFixtureMedia('video',input),
    tts:async(input)=>callFixtureMedia('audio',input)
  }
};
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
		if (url.pathname === "/__proof/state") {
			return Response.json({ calls: mediaCalls });
		}
		if (url.pathname === "/__proof/reset" && request.method === "POST") {
			mediaCalls.length = 0;
			failedCalls.clear();
			return Response.json({ reset: true });
		}
		if (url.pathname === "/__proof/fail-next" && request.method === "POST") {
			const input = await request.json();
			failedCalls.set(input.kind, input.message);
			return Response.json({ armed: input.kind });
		}
		if (url.pathname === "/__proof/media" && request.method === "POST") {
			const input = await request.json();
			mediaCalls.push(input);
			const failure = failedCalls.get(input.kind);
			if (failure) {
				failedCalls.delete(input.kind);
				return Response.json({ message: failure }, { status: 503 });
			}
			const output = outputByKind.get(input.kind);
			if (!output) {
				return Response.json(
					{ message: "No local media fixture is available for this kind." },
					{ status: 404 }
				);
			}
			return Response.json({ url: output });
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
