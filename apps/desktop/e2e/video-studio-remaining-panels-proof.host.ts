import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
	assetSchema,
	projectSchema,
} from "../../../apps-store/video-studio/shared/project.ts";

const desktopDirectory = path.resolve(import.meta.dirname, "..");
const repositoryDirectory = path.resolve(desktopDirectory, "../..");
const sidecarDirectory = path.join(
	repositoryDirectory,
	"apps-store/video-studio/sidecar"
);
const companionDirectory = path.join(
	repositoryDirectory,
	"apps-store/video-studio/ui"
);
const sidecarBinary = path.join(sidecarDirectory, "dist/ryu-video-studio");
const companionHtml = path.join(companionDirectory, "dist/index.html");
const fixtureDirectory = await mkdtemp(
	path.join(tmpdir(), "ryu-video-studio-remaining-panels-")
);
const importRoot = path.join(fixtureDirectory, "import-root");
const videoPath = path.join(fixtureDirectory, "local-video.mp4");
const imagePath = path.join(fixtureDirectory, "local-image.png");
const audioPath = path.join(fixtureDirectory, "local-audio.wav");
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
	"color=c=0x49a4aa:s=320x180:d=0.1",
	"-frames:v",
	"1",
	"-y",
	imagePath,
]);
await run("ffmpeg", [
	"-hide_banner",
	"-loglevel",
	"error",
	"-f",
	"lavfi",
	"-i",
	"sine=frequency=523:duration=2",
	"-ac",
	"1",
	"-ar",
	"16000",
	"-c:a",
	"pcm_s16le",
	"-y",
	audioPath,
]);

const [videoBytes, imageBytes, audioBytes] = await Promise.all([
	readFile(videoPath),
	readFile(imagePath),
	readFile(audioPath),
]);
const imageDataUrl = `data:image/png;base64,${imageBytes.toString("base64")}`;
const audioDataUrl = `data:audio/wav;base64,${audioBytes.toString("base64")}`;
const token = randomUUID();
const sidecarPort = 57_312;
const serverProcess = spawn(sidecarBinary, [], {
	env: {
		...process.env,
		RYU_EXT_TOKEN: token,
		RYU_EXT_PLUGIN_ID: "@ryu/video-studio",
		RYU_CORE_PORT: "27981",
		RYU_PROFILE: "dev",
		RYU_KEYCHAIN: "off",
		RYU_DIR: path.join(fixtureDirectory, "sidecar-data"),
		RYU_VIDEO_STUDIO_PORT: String(sidecarPort),
		RYU_VIDEO_STUDIO_IMPORT_ROOT: importRoot,
		RYU_VIDEO_STUDIO_FFMPEG: ffmpegPath,
		RYU_VIDEO_STUDIO_FFPROBE: ffprobePath,
	},
	stdio: "inherit",
});

let sidecarReady = false;
for (let attempt = 0; attempt < 100; attempt += 1) {
	if (serverProcess.exitCode !== null) {
		throw new Error("The Video Studio sidecar exited during startup.");
	}
	sidecarReady = await fetch(
		`http://127.0.0.1:${sidecarPort}/api/video-studio/projects`,
		{ headers: { authorization: `Bearer ${token}` } }
	).then(
		(response) => response.ok,
		() => false
	);
	if (sidecarReady) {
		break;
	}
	await Bun.sleep(100);
}
if (!sidecarReady) {
	serverProcess.kill();
	await rm(fixtureDirectory, { force: true, recursive: true });
	throw new Error(
		"The authenticated Video Studio sidecar did not become ready."
	);
}

let failNextStockSearch = false;
let failNextTranslation = false;
let failNextDubbing = false;
const stockOrigins = new Map<
	string,
	{
		attribution: string;
		identifier: string;
		licenseUrl: string;
		pageUrl: string;
		provider: "wikimedia.commons";
		rights: string;
	}
>();

const appBridge = `<script>
window.__videoStudioRemainingProof={translationCalls:[],ttsCalls:[]};
window.ryu={
  app:{request:async({path,method="GET",body})=>{
    const response=await fetch("/__studio"+path,{method,headers:{"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const value=await response.json().catch(()=>({message:"The fixture returned an unreadable response."}));
    if(!response.ok)throw new Error(value.message||"Video Studio request failed.");
    return value;
  }},
  model:{complete:async(input)=>{
    window.__videoStudioRemainingProof.translationCalls.push(input);
    const fixture=await fetch("/__proof/take-translation-failure",{method:"POST"}).then((response)=>response.json());
    if(fixture.fail)throw new Error("Fixture caption translation failed once.");
    const request=JSON.parse(input.prompt);
    return JSON.stringify({translations:request.captions.map((caption)=>({id:caption.id,text:"Bonjour: "+caption.text}))});
  }},
  media:{
    image:async()=>${JSON.stringify(imageDataUrl)},
    tts:async(input)=>{
      window.__videoStudioRemainingProof.ttsCalls.push(input);
      const fixture=await fetch("/__proof/take-dubbing-failure",{method:"POST"}).then((response)=>response.json());
      if(fixture.fail)throw new Error("Fixture dubbing failed once.");
      return ${JSON.stringify(audioDataUrl)};
    }
  }
};
</script>`;
const html = (await Bun.file(companionHtml).text()).replace(
	"<head>",
	`<head>${appBridge}`
);

async function sidecarRequest(
	pathname: string,
	method = "GET",
	body?: NonNullable<Parameters<typeof fetch>[1]>["body"]
) {
	return fetch(`http://127.0.0.1:${sidecarPort}/api/video-studio${pathname}`, {
		method,
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		...(body === undefined ? undefined : { body }),
	});
}

function fixtureCreditResponse(
	project: { id: string; revision: number; title: string },
	asset: { id: string; name: string },
	origin: NonNullable<ReturnType<typeof stockOrigins.get>>
) {
	const markdown = [
		`# Credits — ${project.title}`,
		"",
		`Project revision: ${project.revision}`,
		"",
		"## Sources",
		`- **${asset.name}** — ${origin.attribution}`,
		`  Provider: ${origin.provider}; identifier: ${origin.identifier}`,
		`  Rights: ${origin.rights}`,
		`  Source: ${origin.pageUrl}`,
		`  License: ${origin.licenseUrl}`,
		"",
	].join("\n");
	return {
		entries: [
			{
				assetId: asset.id,
				assetName: asset.name,
				attribution: origin.attribution,
				identifier: origin.identifier,
				licenseUrl: origin.licenseUrl,
				pageUrl: origin.pageUrl,
				provider: origin.provider,
				rights: origin.rights,
			},
		],
		markdown,
		projectId: project.id,
		projectRevision: project.revision,
		projectTitle: project.title,
	};
}

const host = Bun.serve({
	hostname: "127.0.0.1",
	port: 5409,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/__ready") {
			return new Response("ok");
		}
		if (url.pathname === "/__proof/image") {
			return new Response(imageBytes, {
				headers: { "content-type": "image/png" },
			});
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
			request.method === "POST" &&
			url.pathname === "/__proof/arm-stock-failure"
		) {
			failNextStockSearch = true;
			return Response.json({ armed: true });
		}
		if (
			request.method === "POST" &&
			url.pathname === "/__proof/arm-translation-failure"
		) {
			failNextTranslation = true;
			return Response.json({ armed: true });
		}
		if (
			request.method === "POST" &&
			url.pathname === "/__proof/take-translation-failure"
		) {
			const fail = failNextTranslation;
			failNextTranslation = false;
			return Response.json({ fail });
		}
		if (
			request.method === "POST" &&
			url.pathname === "/__proof/arm-dubbing-failure"
		) {
			failNextDubbing = true;
			return Response.json({ armed: true });
		}
		if (
			request.method === "POST" &&
			url.pathname === "/__proof/take-dubbing-failure"
		) {
			const fail = failNextDubbing;
			failNextDubbing = false;
			return Response.json({ fail });
		}
		if (url.pathname.startsWith("/__studio/")) {
			const method = request.method;
			const rawBody = ["GET", "HEAD"].includes(method)
				? undefined
				: await request.arrayBuffer();
			if (url.pathname === "/__studio/stock/search" && method === "GET") {
				if (failNextStockSearch) {
					failNextStockSearch = false;
					return Response.json(
						{
							code: "FIXTURE_STOCK_FAILURE",
							message: "Fixture stock search failed once.",
						},
						{ status: 503 }
					);
				}
				const provider = url.searchParams.get("provider") ?? "archive.org";
				return Response.json({
					provider,
					results: [
						{
							attribution: "Ryu coverage fixture. Source attribution retained.",
							duration: 8,
							format: "MP4 video",
							identifier: "coverage-harbor-film",
							provider,
							rights: "Creative Commons Attribution 4.0",
							sizeBytes: videoBytes.byteLength,
							sourceUrl:
								"https://commons.wikimedia.org/wiki/File:Coverage_harbor_film.mp4",
							title: "Coverage harbor film",
						},
					],
				});
			}
			if (url.pathname === "/__studio/stock" && method === "POST" && rawBody) {
				// SAFETY: This controlled stock-import action is published by mounted StockPanel.importResult from a stockSearchResponseSchema-parsed result, and its bridge JSON-serializes the authored identifier/provider string object; foreign raw POST bodies are not validated by this view.
				const input = JSON.parse(new TextDecoder().decode(rawBody)) as {
					identifier?: string;
					provider?: string;
				};
				if (
					input.provider !== "wikimedia.commons" ||
					input.identifier !== "coverage-harbor-film"
				) {
					return Response.json(
						{
							code: "FIXTURE_STOCK_MISMATCH",
							message: "Stock import did not match the selected result.",
						},
						{ status: 400 }
					);
				}
				const localAssetResponse = await sidecarRequest(
					"/assets/import",
					"POST",
					Buffer.from(
						JSON.stringify({
							folder: "Open catalog",
							name: "Coverage harbor film.mp4",
							source: {
								bytes: videoBytes.toString("base64"),
								mimeType: "video/mp4",
							},
						})
					)
				);
				const localAsset = assetSchema.parse(await localAssetResponse.json());
				const origin = {
					attribution: "Ryu coverage fixture. Source attribution retained.",
					identifier: "coverage-harbor-film",
					licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
					pageUrl:
						"https://commons.wikimedia.org/wiki/File:Coverage_harbor_film.mp4",
					provider: "wikimedia.commons" as const,
					rights: "Creative Commons Attribution 4.0",
				};
				stockOrigins.set(localAsset.id, origin);
				return Response.json({ ...localAsset, origin }, { status: 201 });
			}
			if (url.pathname === "/__studio/assets" && method === "GET") {
				const response = await sidecarRequest(
					url.pathname.slice("/__studio".length)
				);
				const value = z
					.object({ assets: assetSchema.array() })
					.parse(await response.json());
				return Response.json({
					...value,
					assets: value.assets.map((asset) => {
						const origin = stockOrigins.get(asset.id);
						return origin ? { ...asset, origin } : asset;
					}),
				});
			}
			const creditsMatch = url.pathname.match(
				/^\/__studio\/projects\/([^/]+)\/credits$/
			);
			if (creditsMatch && method === "GET") {
				const projectResponse = await sidecarRequest(
					`/projects/${creditsMatch[1]}`
				);
				if (projectResponse.ok) {
					const project = projectSchema.parse(await projectResponse.json());
					const usedAssetIds = new Set([
						...project.segments.map((segment) => segment.assetId),
						...project.scenes.flatMap((scene) => scene.assetIds),
					]);
					for (const [assetId, origin] of stockOrigins) {
						if (!usedAssetIds.has(assetId)) {
							continue;
						}
						const assetsResponse = await sidecarRequest("/assets");
						const assets = z
							.object({ assets: assetSchema.array() })
							.parse(await assetsResponse.json());
						const asset = assets.assets.find((item) => item.id === assetId);
						if (asset) {
							return Response.json(
								fixtureCreditResponse(project, asset, origin)
							);
						}
					}
				}
			}
			return sidecarRequest(
				url.pathname.slice("/__studio".length) + url.search,
				method,
				rawBody
			);
		}
		return new Response(html, { headers: { "content-type": "text/html" } });
	},
});

const stop = () => {
	host.stop();
	serverProcess.kill();
	void rm(fixtureDirectory, { force: true, recursive: true });
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
