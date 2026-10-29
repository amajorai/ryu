import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolvePluginDataDir } from "../../../packages/sidecar-runtime/src/index.ts";

const desktopDirectory = path.resolve(import.meta.dirname, "..");
const repositoryDirectory = path.resolve(desktopDirectory, "../..");
const socialUiDirectory = path.join(
	repositoryDirectory,
	"apps-store/social/ui"
);
const socialUiHtml = path.join(socialUiDirectory, "dist/index.html");
const sidecarBinary = path.join(repositoryDirectory, "target/debug/ryu-social");
const fixtureDirectory = await mkdtemp(
	path.join(tmpdir(), "ryu-social-compose-proof-")
);
const dataDirectory = path.join(fixtureDirectory, "ryu-data");
// The sidecar keeps social.db in its plugin-data dir. Resolve that dir with the
// shared layout helper and inject it, as Core does, so the fixture's direct
// SQLite seed opens the sidecar's database rather than an empty file beside it.
const pluginDataDirectory = resolvePluginDataDir(
	{ RYU_DIR: dataDirectory },
	"@ryu/social"
);
const mediaRoot = path.join(fixtureDirectory, "social-media");
const sidecarPort = 5823;
const hostPort = 5423;
const token = randomUUID();

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

const rtkExecutable = Bun.which("rtk");
await run(
	rtkExecutable ?? "cargo",
	rtkExecutable
		? ["cargo", "build", "--offline", "-p", "ryu-social"]
		: ["build", "--offline", "-p", "ryu-social"],
	repositoryDirectory
);
await run("bun", ["run", "build"], socialUiDirectory);

const sidecarProcess = spawn(sidecarBinary, [], {
	env: {
		...process.env,
		RYU_EXT_TOKEN: token,
		RYU_CORE_PORT: "",
		RYU_PROFILE: "dev",
		RYU_KEYCHAIN: "off",
		RYU_DIR: dataDirectory,
		RYU_PLUGIN_DATA_DIR: pluginDataDirectory,
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

async function sidecarApi<Body>(pathname: string, method = "GET", body?: Body) {
	const response = await fetch(
		`http://127.0.0.1:${sidecarPort}/api/social${pathname}`,
		{
			method,
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			...(body === undefined ? undefined : { body: JSON.stringify(body) }),
		}
	);
	const value = await response.json().catch(() => null);
	if (!response.ok) {
		throw new Error(
			`Fixture setup ${method} ${pathname} failed (${response.status}): ${JSON.stringify(value)}`
		);
	}
	return value;
}

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

await sidecarApi("/settings", "PATCH", {
	workspace_id: "default",
	scheduler_enabled: false,
});
await sidecarApi("/accounts", "POST", {
	workspace_id: "default",
	platform: "bluesky",
	account_label: "@compose-proof",
});
// `/accounts` currently creates optimistic `connected: true` rows before the
// provider handshake. Seed the UI-only disconnected state directly in this
// throwaway SQLite fixture so the Compose warning/Settings route can be exercised
// without calling a real provider or changing the satellite backend.
const fixtureDatabase = new Database(
	path.join(pluginDataDirectory, "social.db")
);
fixtureDatabase
	.query(
		"UPDATE social_accounts SET connected = 0 WHERE workspace_id = ?1 AND account_label = ?2"
	)
	.run("default", "@compose-proof");
fixtureDatabase.close();

let failNextDraftCreate = false;
let failNextPostCreate = false;
const bridge = `<script>
window.__socialComposeProof={calls:[]};
window.ryu={
  context:{section:new URLSearchParams(location.search).get("section")||"compose",workspaceId:"default"},
  catalog:{snapshot:async()=>({agents:[],apiTypes:[],current:{provider:"",providerRouting:{},routing:"default"},hookEvents:[],hooks:[],plugins:[],providers:[],thinkingLevels:[],version:1}),models:async()=>({models:[]})},
  social:{
    request:async(input)=>{
      window.__socialComposeProof.calls.push({method:input.method||"GET",path:input.path,...(input.body===undefined?{}:{body:input.body})});
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
		if (request.method === "POST" && url.pathname === "/__proof/fail-draft") {
			failNextDraftCreate = true;
			return Response.json({ armed: true });
		}
		if (request.method === "POST" && url.pathname === "/__proof/fail-post") {
			failNextPostCreate = true;
			return Response.json({ armed: true });
		}
		if (url.pathname.startsWith("/__social")) {
			if (
				failNextDraftCreate &&
				url.pathname === "/__social/drafts" &&
				request.method === "POST"
			) {
				failNextDraftCreate = false;
				await Bun.sleep(250);
				return Response.json(
					{ error: "Fixture rejected the first draft write." },
					{ status: 503 }
				);
			}
			if (
				failNextPostCreate &&
				url.pathname === "/__social/posts" &&
				request.method === "POST"
			) {
				failNextPostCreate = false;
				await Bun.sleep(250);
				return Response.json(
					{ error: "Fixture rejected the first schedule write." },
					{ status: 503 }
				);
			}
			const rawBody = ["GET", "HEAD"].includes(request.method)
				? undefined
				: await request.arrayBuffer();
			return fetch(
				`http://127.0.0.1:${sidecarPort}/api/social${url.pathname.slice("/__social".length)}${url.search}`,
				{
					method: request.method,
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
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
	sidecarProcess.kill();
	void rm(fixtureDirectory, { force: true, recursive: true });
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
