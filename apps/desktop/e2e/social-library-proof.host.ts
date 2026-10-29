import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	forwardNativeSidecarProofRequest,
	runNativeSidecarProofCommand as run,
} from "./native-sidecar-proof-io.ts";

const desktopDirectory = path.resolve(import.meta.dirname, "..");
const repositoryDirectory = path.resolve(desktopDirectory, "../..");
const socialUiDirectory = path.join(
	repositoryDirectory,
	"apps-store/social/ui"
);
const socialUiHtml = path.join(socialUiDirectory, "dist/index.html");
const sidecarBinary = path.join(repositoryDirectory, "target/debug/ryu-social");
const fixtureDirectory = await mkdtemp(
	path.join(tmpdir(), "ryu-social-library-proof-")
);
const dataDirectory = path.join(fixtureDirectory, "ryu-data");
const mediaRoot = path.join(fixtureDirectory, "social-media");
const mediaPath = path.join(mediaRoot, "library-fixture.png");
const outsideMediaPath = path.join(
	fixtureDirectory,
	"outside-library-root.png"
);
const sidecarPort = 5817;
const token = randomUUID();

const rtkExecutable = Bun.which("rtk");
if (rtkExecutable) {
	await run(
		rtkExecutable,
		["cargo", "build", "--offline", "-p", "ryu-social"],
		repositoryDirectory
	);
} else {
	await run(
		"cargo",
		["build", "--offline", "-p", "ryu-social"],
		repositoryDirectory
	);
}
await run("bun", ["run", "build"], socialUiDirectory);
await mkdir(mediaRoot, { recursive: true });
const imageBytes = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/tmkAAAAASUVORK5CYII=",
	"base64"
);
await Promise.all([
	writeFile(mediaPath, imageBytes),
	writeFile(outsideMediaPath, imageBytes),
]);

const sidecarProcess = spawn(sidecarBinary, [], {
	env: {
		...process.env,
		RYU_EXT_TOKEN: token,
		RYU_CORE_PORT: "",
		RYU_PROFILE: "dev",
		RYU_KEYCHAIN: "off",
		RYU_DIR: dataDirectory,
		RYU_SOCIAL_PORT: String(sidecarPort),
		RYU_SOCIAL_MEDIA_ROOT: mediaRoot,
		RYU_SOCIAL_FAKE_PROVIDER: "1",
		RYU_SOCIAL_SCHEDULER: "0",
		RUST_LOG: "warn",
	},
	stdio: "inherit",
});

let sidecarReady = false;
for (let attempt = 0; attempt < 120; attempt += 1) {
	if (sidecarProcess.exitCode !== null) {
		throw new Error("The ryu-social sidecar exited during startup.");
	}
	sidecarReady = await fetch(`http://127.0.0.1:${sidecarPort}/health`).then(
		(response) => response.ok,
		() => false
	);
	if (sidecarReady) {
		break;
	}
	await Bun.sleep(100);
}
if (!sidecarReady) {
	sidecarProcess.kill();
	await rm(fixtureDirectory, { force: true, recursive: true });
	throw new Error("The local ryu-social sidecar did not become healthy.");
}

const bridge = `<script>
window.__socialLibraryProof={calls:[],navigations:[]};
window.ryu={
  context:{section:"library",workspaceId:"default"},
  social:{
    request:async(input)=>{
      window.__socialLibraryProof.calls.push(input);
      const response=await fetch("/__social"+input.path,{method:input.method||"GET",headers:{"content-type":"application/json"},...(input.body===undefined?{}:{body:JSON.stringify(input.body)})});
      const value=await response.json().catch(()=>({error:"The local fixture returned an unreadable response."}));
      if(!response.ok)throw new Error(value.error||value.message||"The social sidecar request failed.");
      return value;
    },
    open:async(input)=>{window.__socialLibraryProof.navigations.push({kind:"post",...input});},
    openList:async()=>{window.__socialLibraryProof.navigations.push({kind:"list"});}
  }
};
</script>`;
const html = (await Bun.file(socialUiHtml).text()).replace(
	"<head>",
	`<head>${bridge}`
);

const host = Bun.serve({
	hostname: "127.0.0.1",
	port: 5417,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/__ready") {
			return new Response("ok");
		}
		if (url.pathname === "/__proof/media-path") {
			return Response.json({
				path: await realpath(mediaPath),
				outsidePath: await realpath(outsideMediaPath),
			});
		}
		if (url.pathname === "/__proof/media-exists") {
			return Response.json({
				inside: await Bun.file(mediaPath).exists(),
				outside: await Bun.file(outsideMediaPath).exists(),
			});
		}
		if (url.pathname.startsWith("/__social")) {
			return forwardNativeSidecarProofRequest(
				request,
				`http://127.0.0.1:${sidecarPort}/api/social${url.pathname.slice("/__social".length)}${url.search}`,
				token
			);
		}
		return new Response(html, { headers: { "content-type": "text/html" } });
	},
});

const stop = () => {
	host.stop();
	sidecarProcess.kill();
	void rm(fixtureDirectory, { force: true, recursive: true });
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
