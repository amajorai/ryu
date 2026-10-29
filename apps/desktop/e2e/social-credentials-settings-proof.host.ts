import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
	path.join(tmpdir(), "ryu-social-credentials-settings-proof-")
);
const dataDirectory = path.join(fixtureDirectory, "ryu-data");
const mediaRoot = path.join(fixtureDirectory, "social-media");
const sidecarPort = 5822;
const hostPort = 5422;
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
		RYU_SOCIAL_TREG_BASE_URL: "",
		RYU_TREG_URL: "",
		TREG_URL: "",
		RYU_SOCIAL_BLUESKY_HANDLE: "",
		RYU_SOCIAL_BLUESKY_APP_PASSWORD: "",
		RYU_SOCIAL_BLUESKY_PDS: "",
		RYU_SOCIAL_THREADS_ACCESS_TOKEN: "fixture-env-only-token-never-valid",
		RYU_SOCIAL_THREADS_USER_ID: "",
		RYU_SOCIAL_ACCOUNT_PROVIDERS: "",
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

let failNextSettingsPatch = false;
const bridge = `<script>
window.__socialCredentialsSettingsProof={calls:[]};
window.ryu={
  context:{section:"settings",workspaceId:"default"},
  social:{
    request:async(input)=>{
      window.__socialCredentialsSettingsProof.calls.push(input);
      const response=await fetch("/__social"+input.path,{method:input.method||"GET",headers:{"content-type":"application/json"},...(input.body===undefined?{}:{body:JSON.stringify(input.body)})});
      const value=await response.json().catch(()=>({error:"The local fixture returned an unreadable response."}));
      if(!response.ok)throw new Error(value.error||value.message||"The social sidecar request failed.");
      return value;
    },
    open:async()=>{},
    openList:async()=>{}
  }
};
</script>`;
const html = (await Bun.file(socialUiHtml).text()).replace(
	"<head>",
	`<head>${bridge}`
);

const host = Bun.serve({
	hostname: "127.0.0.1",
	port: hostPort,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/__ready") {
			return new Response("ok");
		}
		if (
			url.pathname === "/__proof/fail-next-settings-patch" &&
			request.method === "POST"
		) {
			failNextSettingsPatch = true;
			return Response.json({ armed: true });
		}
		if (url.pathname.startsWith("/__social")) {
			if (
				failNextSettingsPatch &&
				url.pathname === "/__social/settings" &&
				request.method === "PATCH"
			) {
				failNextSettingsPatch = false;
				await Bun.sleep(300);
				return Response.json(
					{ error: "Fixture rejected the first credential write." },
					{ status: 503 }
				);
			}
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
