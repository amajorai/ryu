import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
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
	path.join(tmpdir(), "ryu-social-compose-children-proof-")
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
const sidecarPort = 5824;
const hostPort = 5424;
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
	const value = z.json().parse(await response.json().catch(() => null));
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

const bridge = `<script>
window.__socialComposeChildrenProof={calls:[],modelCalls:[],responses:[]};
window.ryu={
  context:{section:new URLSearchParams(location.search).get("section")||"compose",workspaceId:"default"},
  catalog:{snapshot:async()=>({agents:[],apiTypes:[],current:{provider:"",providerRouting:{},routing:"default"},hookEvents:[],hooks:[],plugins:[],providers:[],thinkingLevels:[],version:1}),models:async()=>({})},
  model:{complete:async(input)=>{
    const proof=window.__socialComposeChildrenProof;
    proof.modelCalls.push(input);
    if(input.prompt.startsWith("Suggest up to 8")&&proof.modelCalls.filter((call)=>call.prompt.startsWith("Suggest up to 8")).length===1){throw new Error("Fixture model temporarily unavailable.");}
    if(input.prompt.startsWith("Suggest up to 8"))return "#Launch\\n#Proof\\n#Launch";
    if(input.prompt.startsWith("Rewrite this post so it reads natively on LinkedIn"))return "A LinkedIn-first launch message.";
    if(input.prompt.startsWith("Rate how strong"))return "91\\nThe opening line is clear and specific.";
    throw new Error("Unexpected AI assist prompt in the local fixture.");
  }},
  social:{
    request:async(input)=>{
      window.__socialComposeChildrenProof.calls.push({method:input.method||"GET",path:input.path,...(input.body===undefined?{}:{body:input.body})});
      const response=await fetch("/__social"+input.path,{method:input.method||"GET",headers:{"content-type":"application/json"},...(input.body===undefined?{}:{body:JSON.stringify(input.body)})});
      const value=await response.json().catch(()=>({error:"The local fixture returned an unreadable response."}));
      window.__socialComposeChildrenProof.responses.push({method:input.method||"GET",path:input.path,value});
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

let failNextBestTimes = true;
let seededFixture:
	| {
			accounts: Array<{ id: string }>;
			media: {
				attachPath: string;
				enterPath: string;
				libraryAsset: Awaited<ReturnType<typeof sidecarApi>>;
				libraryPath: string;
			};
	  }
	| undefined;

const host = Bun.serve({
	hostname: "127.0.0.1",
	port: hostPort,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/__ready") {
			return new Response("ok");
		}
		if (url.pathname === "/__proof/seed" && request.method === "POST") {
			if (seededFixture) {
				return Response.json(seededFixture);
			}
			await mkdir(mediaRoot, { recursive: true });
			const libraryPath = path.join(mediaRoot, "library-seed.png");
			const enterPath = path.join(mediaRoot, "direct-enter.png");
			const attachPath = path.join(mediaRoot, "direct-attach.png");
			await Promise.all([
				writeFile(libraryPath, "local library image fixture"),
				writeFile(enterPath, "local Enter attachment fixture"),
				writeFile(attachPath, "local Attach button fixture"),
			]);

			await sidecarApi("/settings", "PATCH", {
				workspace_id: "default",
				scheduler_enabled: false,
			});
			const bluesky = z
				.object({ id: z.string() })
				.passthrough()
				.parse(
					await sidecarApi("/accounts", "POST", {
						workspace_id: "default",
						platform: "bluesky",
						account_label: "@children-bluesky",
					})
				);
			const linkedin = z
				.object({ id: z.string() })
				.passthrough()
				.parse(
					await sidecarApi("/accounts", "POST", {
						workspace_id: "default",
						platform: "linkedin",
						account_label: "@children-linkedin",
					})
				);
			const fixtureDatabase = new Database(
				path.join(pluginDataDirectory, "social.db")
			);
			fixtureDatabase
				.query("UPDATE social_accounts SET connected = 0 WHERE id IN (?1, ?2)")
				.run(bluesky.id, linkedin.id);
			fixtureDatabase.close();
			const libraryAsset = await sidecarApi("/media", "POST", {
				workspace_id: "default",
				path: libraryPath,
				name: "library-seed.png",
				mime_type: "image/png",
			});
			seededFixture = {
				accounts: [bluesky, linkedin],
				media: { attachPath, enterPath, libraryAsset, libraryPath },
			};
			return Response.json(seededFixture);
		}
		if (url.pathname.startsWith("/__social")) {
			if (
				failNextBestTimes &&
				url.pathname === "/__social/best-times" &&
				request.method === "GET"
			) {
				failNextBestTimes = false;
				return Response.json(
					{
						error: "Fixture could not load posting times on the first request.",
					},
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
