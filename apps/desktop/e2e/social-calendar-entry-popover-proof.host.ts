import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	isNativeNumber,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
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
	path.join(tmpdir(), "ryu-social-calendar-entry-popover-proof-")
);
const dataDirectory = path.join(fixtureDirectory, "ryu-data");
// The sidecar keeps social.db in its plugin-data dir. Resolve that dir with the
// shared layout helper and inject it, as Core does, so these seeds open the
// sidecar's database rather than an empty file beside it.
const pluginDataDirectory = resolvePluginDataDir(
	{ RYU_DIR: dataDirectory },
	"@ryu/social"
);
const databasePath = path.join(pluginDataDirectory, "social.db");
const mediaRoot = path.join(fixtureDirectory, "social-media");
const sidecarPort = 5820;
const hostPort = 5420;
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
		RYU_PLUGIN_DATA_DIR: pluginDataDirectory,
		RYU_SOCIAL_PORT: String(sidecarPort),
		RYU_SOCIAL_MEDIA_ROOT: mediaRoot,
		RYU_SOCIAL_FAKE_PROVIDER: "1",
		RYU_SOCIAL_SCHEDULER: "0",
		RYU_SOCIAL_BLUESKY_HANDLE: "",
		RYU_SOCIAL_BLUESKY_APP_PASSWORD: "",
		RYU_SOCIAL_THREADS_ACCESS_TOKEN: "",
		RYU_SOCIAL_THREADS_USER_ID: "",
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

let failNextReschedule = false;
const bridge = `<script>
window.__socialCalendarEntryProof={calls:[]};
window.ryu={
  context:{section:"calendar",workspaceId:"default"},
  social:{
    request:async(input)=>{
      window.__socialCalendarEntryProof.calls.push(input);
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
			url.pathname === "/__proof/fail-next-reschedule" &&
			request.method === "POST"
		) {
			failNextReschedule = true;
			return Response.json({ armed: true });
		}
		if (
			url.pathname === "/__proof/seed-failed-post" &&
			request.method === "POST"
		) {
			const body = await request.json();
			if (!(isNativeText(body.postId) && isNativeText(body.targetId))) {
				return Response.json(
					{ error: "A post and target id are required." },
					{ status: 400 }
				);
			}
			const database = new Database(databasePath);
			try {
				database.exec("BEGIN IMMEDIATE");
				const post = database
					.query(
						"UPDATE scheduled_posts SET status = 'failed' WHERE id = ? AND status = 'scheduled'"
					)
					.run(body.postId);
				const target = database
					.query(
						"UPDATE post_targets SET status = 'failed', attempts = 3, next_attempt_at = NULL, claimed_at = NULL WHERE id = ? AND scheduled_post_id = ? AND status = 'pending'"
					)
					.run(body.targetId, body.postId);
				if (post.changes !== 1 || target.changes !== 1) {
					database.exec("ROLLBACK");
					return Response.json(
						{
							error:
								"The fixture could not mark one scheduled target as failed.",
						},
						{ status: 409 }
					);
				}
				database
					.query(
						"INSERT INTO post_history (id, post_target_id, status, remote_url, remote_id, error, published_at) VALUES (?, ?, 'failed', NULL, NULL, ?, ?)"
					)
					.run(
						randomUUID(),
						body.targetId,
						"Fixture: simulated provider failure",
						Date.now()
					);
				database.exec("COMMIT");
				return Response.json({ seeded: true });
			} catch (error) {
				try {
					database.exec("ROLLBACK");
				} catch {
					// The transaction may already have been rolled back by SQLite.
				}
				return Response.json(
					{
						error:
							error instanceof Error
								? error.message
								: "Could not seed failed state.",
					},
					{ status: 500 }
				);
			} finally {
				database.close();
			}
		}
		if (
			url.pathname === "/__proof/seed-published-activity" &&
			request.method === "POST"
		) {
			const body = await request.json();
			if (
				!(
					isNativeText(body.accountId) &&
					isNativeText(body.permalink) &&
					isNativeNumber(body.publishedAt) &&
					isNativeText(body.text)
				)
			) {
				return Response.json(
					{ error: "Published activity fields are required." },
					{ status: 400 }
				);
			}
			const id = randomUUID();
			const database = new Database(databasePath);
			try {
				database
					.query(
						"INSERT INTO activity_items (id, workspace_id, social_account_id, platform, post_remote_id, permalink, text, published_at) VALUES (?, 'default', ?, 'bluesky', ?, ?, ?, ?)"
					)
					.run(
						id,
						body.accountId,
						`fixture-${id}`,
						body.permalink,
						body.text,
						body.publishedAt
					);
				return Response.json({ id });
			} catch (error) {
				return Response.json(
					{
						error:
							error instanceof Error
								? error.message
								: "Could not seed activity.",
					},
					{ status: 500 }
				);
			} finally {
				database.close();
			}
		}
		if (url.pathname.startsWith("/__social")) {
			if (
				failNextReschedule &&
				url.pathname.startsWith("/__social/posts/") &&
				request.method === "PATCH"
			) {
				failNextReschedule = false;
				return Response.json(
					{ error: "Fixture rejected the first reschedule." },
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
