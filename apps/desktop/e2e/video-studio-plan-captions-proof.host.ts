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
	path.join(tmpdir(), "ryu-video-studio-plan-captions-proof-")
);
const videoPath = path.join(fixtureDirectory, "storyboard-video.mp4");

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
	"-c:v",
	"libx264",
	"-preset",
	"ultrafast",
	"-pix_fmt",
	"yuv420p",
	"-movflags",
	"+faststart",
	"-t",
	"8",
	"-y",
	videoPath,
]);
const videoBytes = await readFile(videoPath);
const token = randomUUID();
const sidecarPort = 57_261;
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
let failNextSceneDraft = false;
const bridge = `<script>
window.__coverageModelCalls=[];
const studioRequest=async(input)=>{
  const response=await fetch('/__studio'+input.path,{method:input.method||'GET',headers:{'content-type':'application/json'},...(input.body===undefined?{}:{body:JSON.stringify(input.body)})});
  const result=await response.json();
  if(!response.ok)throw new Error(result.message||'Request failed');
  return result;
};
const localModelComplete=async(input)=>{
  window.__coverageModelCalls.push(input);
  if(input.system.includes('film production planner')){
    const armed=await fetch('/__proof/take-scene-draft-failure',{method:'POST'}).then((response)=>response.json());
    if(armed.fail)throw new Error('Fixture scene draft failed once.');
    return JSON.stringify({scenes:[
      {title:'Open with context',script:'Meet the people behind the harbor.',prompt:'Wide sunrise view over working docks.'},
      {title:'Show the craft',script:'Every vessel carries a story.',prompt:'Close details of careful hands at work.'},
      {title:'Leave a trace',script:'The next chapter starts here.',prompt:'Golden light across the water at dusk.'}
    ]});
  }
  if(input.system.includes('Translate the supplied caption text')){
    const request=JSON.parse(input.prompt);
    return JSON.stringify({translations:request.captions.map((caption)=>({id:caption.id,text:'Bonjour: '+caption.text}))});
  }
  throw new Error('Unconfigured local model fixture.');
};
window.ryu={app:{request:studioRequest},model:{complete:localModelComplete}};
</script>`;
const html = (await Bun.file(appHtml).text()).replace(
	"<head>",
	`<head>${bridge}`
);
const host = Bun.serve({
	hostname: "127.0.0.1",
	port: 5402,
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
			url.pathname === "/__proof/arm-scene-draft-failure" &&
			request.method === "POST"
		) {
			failNextSceneDraft = true;
			return Response.json({ armed: true });
		}
		if (
			url.pathname === "/__proof/take-scene-draft-failure" &&
			request.method === "POST"
		) {
			const fail = failNextSceneDraft;
			failNextSceneDraft = false;
			return Response.json({ fail });
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
