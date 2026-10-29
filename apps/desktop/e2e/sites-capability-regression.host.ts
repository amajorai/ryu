import { Database } from "bun:sqlite";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createSitesServer,
	type SitesServices,
} from "../../../apps-store/sites/sidecar/src/server.ts";
import { SitesStore } from "../../../apps-store/sites/sidecar/src/store.ts";
import { visitorScript } from "../../../apps-store/sites/sidecar/src/visitor-bundle.ts";
import type { LegacySiteRecord } from "../../../apps-store/sites/sidecar/src/spaces-database.ts";
const desktopDirectory = path.resolve(import.meta.dirname, "..");
const repositoryDirectory = path.resolve(desktopDirectory, "../..");
const directory = await mkdtemp(
	path.join(tmpdir(), "ryu-sites-capability-regression-")
);
const store = new SitesStore(path.join(directory, "sites.sqlite"));
const database = new Database(path.join(directory, "spaces-fixture.sqlite"));
database.run(
	"CREATE TABLE data(owner TEXT,collection TEXT,key TEXT PRIMARY KEY,value TEXT)"
);
const owner = {
	id: "capability-owner",
	email: "owner@example.test",
	workspaceIds: ["capability-team"],
};
const other = {
	id: "independent-owner",
	email: "other@example.test",
	workspaceIds: ["capability-team"],
};
const token = crypto.randomUUID();
const installations: unknown[] = [];
const databaseCalls: Array<{ method: string; input: unknown }> = [];
const binding = {
	spaceId: "capability-space",
	databaseId: "capability-database",
};
const save = (record: LegacySiteRecord) => {
	database
		.query("INSERT OR REPLACE INTO data VALUES(?,?,?,?)")
		.run(record.owner, record.collection, record.key, record.value);
};
function assertBinding(input: unknown) {
	const candidate = input as Record<string, unknown> | null;
	if (
		!candidate ||
		candidate.databaseId !== binding.databaseId ||
		candidate.spaceId !== binding.spaceId ||
		Object.keys(candidate).sort().join(",") !== "databaseId,spaceId"
	) {
		throw new Error("Unexpected Spaces database authority.");
	}
}
const services: SitesServices = {
	managementIdentity: async () => owner,
	identity: async (request) =>
		request.headers.get("cookie")?.includes("capability-owner=1")
			? owner
			: null,
	mcpIdentity: async (request) =>
		request.headers.get("authorization") === "Bearer capability-reader"
			? owner
			: null,
	authorizationServer: "https://identity.example.test",
	scanArtifact: async () => ({ allowed: true, reason: null }),
	installPlugin: async (manifest, request) => {
		if (request.headers.get("authorization") !== `Bearer ${token}`) {
			throw new Error("Installer must receive management authority.");
		}
		installations.push(structuredClone(manifest));
		await writeFile(
			path.join(directory, "installed-manifests.json"),
			JSON.stringify(installations)
		);
		return { installed: true, manifest };
	},
	connections: () => [
		{
			id: "approved-read",
			label: "Approved read connector",
			toolId: "fixture.read",
			agentId: "ryu",
			readOnly: true,
		},
	],
	invokeConnection: async () => {
		throw new Error(
			"Visitor connector invocation is outside this management fixture."
		);
	},
	spacesDatabase: {
		ensureForSite: async (input) => {
			databaseCalls.push({ method: "ensureForSite", input });
			return binding;
		},
		importRecords: async (input, records) => {
			assertBinding(input);
			databaseCalls.push({ method: "importRecords", input: records });
			for (const record of records) {
				save(record);
			}
		},
		query: async (input, statement, parameters) => {
			assertBinding(input);
			databaseCalls.push({ method: "query", input: { statement, parameters } });
			if (!/^SELECT\b/iu.test(statement)) {
				throw new Error("Spaces SQL fixture permits SELECT only.");
			}
			const query = database.query(statement);
			return {
				columns: query.columnNames,
				rows: query.values(...((parameters ?? []) as string[])),
				schema: [],
				truncated: false,
			};
		},
		count: async (input) => {
			assertBinding(input);
			return (
				database.query("SELECT COUNT(*) AS count FROM data").get() as {
					count: number;
				}
			).count;
		},
		records: async (input, id, collection, key) => {
			assertBinding(input);
			return (
				database
					.query(
						"SELECT key,value FROM data WHERE owner=? AND collection=? AND (? IS NULL OR key=?)"
					)
					.all(id, collection, key, key) as { key: string; value: string }[]
			).map((record) => ({ key: record.key, value: JSON.parse(record.value) }));
		},
		saveRecord: async (input, record) => {
			assertBinding(input);
			save(record);
		},
		deleteRecord: async (input, id, collection, key) => {
			assertBinding(input);
			return (
				database
					.query("DELETE FROM data WHERE owner=? AND collection=? AND key=?")
					.run(id, collection, key).changes > 0
			);
		},
		deleteDatabase: async (input) => {
			assertBinding(input);
			database.run("DELETE FROM data");
		},
	},
};
const sidecar = createSitesServer({
	store,
	token,
	ownerId: owner.id,
	port: 0,
	visitorPort: 0,
	services,
	visitorScript,
	publicEnabled: true,
	baseDomain: "localhost",
});
let ids = { owned: "", shared: "", hidden: "" };
function seed(mcp = true) {
	for (const site of store.list()) {
		store.db.query("DELETE FROM sites WHERE id=?").run(site.id);
	}
	installations.length = 0;
	databaseCalls.length = 0;
	database.run("DELETE FROM data");
	save({
		owner: owner.id,
		collection: "notes",
		key: "first",
		value: JSON.stringify({ text: "Keep rollback" }),
	});
	save({
		owner: owner.id,
		collection: "notes",
		key: "second",
		value: JSON.stringify({ text: "Verify import" }),
	});
	const owned = store.create(
		{
			name: "Owned capability board",
			slug: "owned-capability-board",
			template: "dashboard",
		},
		owner
	);
	const shared = store.create(
		{
			name: "Independent shared board",
			slug: "independent-shared-board",
			template: "website",
		},
		other
	);
	const hidden = store.create(
		{
			name: "Uninvited private board",
			slug: "uninvited-private-board",
			template: "website",
		},
		other
	);
	ids = { owned: owned.id, shared: shared.id, hidden: hidden.id };
	for (const [site, isOwner] of [
		[owned, true],
		[shared, false],
	] as const) {
		const html =
			"<!doctype html><html><head><title>Capability board</title></head><body><h1>Capability board</h1></body></html>";
		const publishedId = crypto.randomUUID();
		store.mutate(site.id, 0, (current) => {
			// Match the production version route: a unique artifact and its version
			// metadata are created together inside the actual store transaction.
			store.db
				.query("INSERT INTO artifacts VALUES(?,?,?)")
				.run(site.id, publishedId, html);
			current.settings.workspaceId = "capability-team";
			if (!isOwner) {
				current.settings.audience = "invited";
				current.settings.viewers = [owner.email];
			}
			current.settings.extensions = {
				mcp: isOwner && mcp,
				ui: isOwner && mcp,
				tools: isOwner
					? [
							{
								name: "list_notes",
								description: "List saved notes",
								operation: "records.list",
								collection: "notes",
							},
						]
					: [],
				connections: [],
			};
			current.versions = [
				{
					id: publishedId,
					bytes: html.length,
					message: "Seeded published artifact",
					createdAt: new Date().toISOString(),
					commit: null,
					extensions: structuredClone(current.settings.extensions),
				},
			];
			current.deploymentId = publishedId;
			current.hasPublished = true;
		});
		if (store.artifact(site.id, publishedId) !== html) {
			throw new Error("Seeded published artifact must read back exactly.");
		}
	}
	const today = new Date().toISOString().slice(0, 10);
	const yesterday = new Date(Date.now() - 86_400_000)
		.toISOString()
		.slice(0, 10);
	const old = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
	for (const row of [
		[today, "visitor-one", 3],
		[today, "visitor-two", 1],
		[yesterday, "visitor-one", 2],
		[old, "old-only", 9],
	] as const) {
		store.db.query("INSERT INTO traffic VALUES(?,?,?,?)").run(owned.id, ...row);
	}
}
seed();
async function build(cwd: string, args: string[]) {
	const child = Bun.spawn([process.execPath, "x", "vite", "build", ...args], {
		cwd,
		stdout: "inherit",
		stderr: "inherit",
	});
	if ((await child.exited) !== 0) {
		throw new Error("Actual Sites capability build failed.");
	}
}
await build(path.join(repositoryDirectory, "apps-store/sites/ui"), [
	"--outDir",
	path.join(tmpdir(), "ryu-sites-capability-regression-ui-build"),
]);
await build(desktopDirectory, [
	"--config",
	"e2e/harness/vite.sites-capability-regression.config.ts",
]);
const hostBuild = path.join(
	tmpdir(),
	"ryu-sites-capability-regression-host-build"
);
const host = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.RYU_SITES_CAPABILITY_PORT ?? 5531),
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/__ready") {
			return Response.json({ ready: true });
		}
		if (url.pathname === "/__proof/reset" && request.method === "POST") {
			seed(((await request.json()) as { mcp?: boolean }).mcp ?? true);
			return Response.json(ids);
		}
		if (url.pathname === "/__proof/state") {
			return Response.json({
				ids,
				projects: store.list(),
				installations,
				databaseCalls,
				visitorPort: sidecar.visitor.port,
				installedFile: await readFile(
					path.join(directory, "installed-manifests.json"),
					"utf8"
				).catch(() => "[]"),
			});
		}
		if (url.pathname.startsWith("/__proof/sites/")) {
			const route = url.pathname.slice("/__proof/sites".length) + url.search;
			const body = request.method === "GET" ? undefined : await request.text();
			return await fetch(`http://127.0.0.1:${sidecar.admin.port}${route}`, {
				method: request.method,
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body,
			});
		}
		const filePath = path.resolve(
			hostBuild,
			url.pathname === "/"
				? "sites-capability-regression.html"
				: url.pathname.slice(1)
		);
		if (!filePath.startsWith(hostBuild + "/")) {
			return new Response("Forbidden", { status: 403 });
		}
		const file = Bun.file(filePath);
		return (await file.exists())
			? new Response(file)
			: new Response("Not found", { status: 404 });
	},
});
process.on("SIGTERM", () => {
	host.stop(true);
	sidecar.stop();
	store.close();
	database.close();
	process.exit(0);
});
