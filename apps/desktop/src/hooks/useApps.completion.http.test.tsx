import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

// Native transport is restored after happy-dom so the shipping roster hook and
// lifecycle clients reach a real Bun peer that owns the authoritative records.
const native = {
	fetch: globalThis.fetch,
	Response: globalThis.Response,
	Request: globalThis.Request,
	Headers: globalThis.Headers,
	AbortController: globalThis.AbortController,
	AbortSignal: globalThis.AbortSignal,
};
if (typeof document === "undefined") {
	GlobalRegistrator.register();
}
Object.assign(globalThis, native);
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { useApps } = await import("./useApps.ts");
const { useNodeStore } = await import("../store/useNodeStore.ts");
const { queryClient } = await import("../lib/query-client.ts");
const { QueryClientProvider } = await import("@tanstack/react-query");

const previousNodes = useNodeStore.getState();
const TOKEN = "roster-node-token";

interface CoreApp {
	enabled: boolean;
	id: string;
	installed: boolean;
	installed_version: string | null;
}
interface Call {
	method: string;
	path: string;
	replied: string | null;
	status: number;
}
/** How Core answers the next lifecycle POST. `misdirect` applies the requested
 *  change but acknowledges another app's record; `malformed` changes nothing and
 *  answers HTTP 200 with a body that is not an app record. */
type Reply =
	| { kind: "ack" }
	| { kind: "misdirect"; to: string }
	| {
			kind: "malformed";
	  };

function startPeer(initial: CoreApp[]) {
	const apps = new Map(initial.map((app) => [app.id, { ...app }]));
	const calls: Call[] = [];
	const unknown: string[] = [];
	let next: Reply = { kind: "ack" };
	const wire = (app: CoreApp) => ({
		id: app.id,
		name: `${app.id} app`,
		version: "2.0.0",
		built_in: false,
		enabled: app.enabled,
		installed: app.installed,
		installed_version: app.installed_version,
		local_only: false,
		windows_first: false,
		permission_grants: [],
		runnables: [],
		sidecar_name: null,
	});
	const record = (app: CoreApp) => ({
		id: app.id,
		enabled: app.enabled,
		version: app.installed_version ?? "2.0.0",
		approved_grants: [],
		created_at: null,
		updated_at: null,
	});
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
				unknown.push(`unauthorized ${request.method} ${url.pathname}`);
				return Response.json({ error: "unauthorized" }, { status: 401 });
			}
			const call: Call = {
				method: request.method,
				path: url.pathname + url.search,
				status: 200,
				replied: null,
			};
			calls.push(call);
			if (request.method === "GET" && url.pathname === "/api/plugins") {
				return Response.json({ apps: [...apps.values()].map(wire) });
			}
			const lifecycle = url.pathname.match(
				/^\/api\/plugins\/([^/]+)\/(enable|disable|install)$/
			);
			const target = lifecycle ? apps.get(lifecycle[1] ?? "") : undefined;
			if (request.method !== "POST" || !(lifecycle && target) || url.search) {
				unknown.push(`undeclared ${request.method} ${call.path}`);
				call.status = 404;
				return Response.json({ error: "undeclared" }, { status: 404 });
			}
			const reply = next;
			next = { kind: "ack" };
			if (reply.kind === "malformed") {
				call.replied = "malformed";
				return Response.json({ app: { id: target.id } });
			}
			if (lifecycle[2] === "install") {
				target.installed = true;
				target.installed_version = "2.0.0";
			} else {
				target.enabled = lifecycle[2] === "enable";
			}
			const acknowledged =
				reply.kind === "misdirect" ? apps.get(reply.to) : target;
			if (!acknowledged) {
				throw new Error("Fixture misdirect target missing");
			}
			call.replied = acknowledged.id;
			return Response.json({ app: record(acknowledged) });
		},
	});
	const node = {
		name: "roster-node",
		url: `http://127.0.0.1:${server.port}`,
		token: TOKEN,
	};
	useNodeStore.setState({
		nodes: [node],
		localNodes: [node],
		cloudNodes: [],
		defaultNode: node.name,
		autoSelect: false,
		autoSelectedNode: null,
		tabOverrides: {},
	});
	return {
		apps,
		calls,
		unknown,
		reply(value: Reply) {
			next = value;
		},
		stop: () => server.stop(true),
	};
}

let root: ReturnType<typeof createRoot> | undefined;
let peer: ReturnType<typeof startPeer> | undefined;
let latest: ReturnType<typeof useApps>;
const runtimeErrors: string[] = [];

function Consumer() {
	latest = useApps();
	return null;
}
async function mount() {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container, {
		onCaughtError: (error) => runtimeErrors.push(String(error)),
		onUncaughtError: (error) => runtimeErrors.push(String(error)),
	});
	await act(async () =>
		root?.render(
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(Consumer)
			)
		)
	);
}
async function settle(label: string, predicate: () => boolean) {
	for (let attempt = 0; attempt < 300; attempt += 1) {
		if (predicate() && queryClient.isFetching() === 0) {
			return;
		}
		await act(async () => {
			await Bun.sleep(10);
		});
	}
	throw new Error(`App roster consumer did not acknowledge: ${label}`);
}
const shown = () =>
	latest.apps.map(({ id, enabled, installed, installedVersion }) => ({
		id,
		enabled,
		installed,
		installedVersion,
	}));
const coreTruth = (current: ReturnType<typeof startPeer>) =>
	[...current.apps.values()].map((app) => ({
		id: app.id,
		enabled: app.enabled,
		installed: app.installed,
		installedVersion: app.installed_version,
	}));
const posts = (current: ReturnType<typeof startPeer>) =>
	current.calls
		.filter((call) => call.method === "POST")
		.map(({ path, replied }) => ({ path, replied }));

/** An independent mount with an empty cache reads only Core's records. */
async function freshReload() {
	await act(async () => root?.unmount());
	queryClient.clear();
	await mount();
	await settle("fresh roster", () => latest.apps.length > 0);
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	await queryClient.cancelQueries();
	queryClient.clear();
	peer?.stop();
	peer = undefined;
	useNodeStore.setState(previousNodes);
	document.body.replaceChildren();
	const errors = runtimeErrors.splice(0);
	if (errors.length > 0) {
		throw new Error(
			`Mounted consumer reported runtime errors: ${errors.join("; ")}`
		);
	}
});

test("malformed or wrong-app toggle completions are never reported as success; the roster follows Core and a retry is acknowledged", async () => {
	const current = startPeer([
		{
			id: "shared",
			enabled: true,
			installed: true,
			installed_version: "2.0.0",
		},
		{
			id: "unrelated",
			enabled: true,
			installed: true,
			installed_version: "2.0.0",
		},
	]);
	peer = current;
	await mount();
	await settle("roster", () => latest.apps.length === 2);

	current.reply({ kind: "malformed" });
	let outcome: Awaited<ReturnType<typeof latest.toggle>> | undefined;
	await act(async () => {
		outcome = await latest.toggle("shared", false);
	});
	expect(outcome?.success).toBe(false);
	await settle("malformed rollback", () => latest.toggleError !== null);
	expect(shown()).toEqual(coreTruth(current));
	expect(current.apps.get("shared")?.enabled).toBe(true);

	// Core disables `shared` but acknowledges `unrelated`: no consumer may treat
	// that as confirmation (e.g. announce "ready" and open the app).
	current.reply({ kind: "misdirect", to: "unrelated" });
	await act(async () => {
		outcome = await latest.toggle("shared", false);
	});
	expect(outcome).toEqual({
		success: false,
		error:
			"Core confirmed a different app (unrelated); the app list was reloaded.",
	});
	await settle("authoritative roster after misdirect", () =>
		latest.apps.some((app) => app.id === "shared" && !app.enabled)
	);
	expect(latest.toggleError).toBe(
		"Core confirmed a different app (unrelated); the app list was reloaded."
	);
	expect(shown()).toEqual(coreTruth(current));
	expect(current.apps.get("unrelated")?.enabled).toBe(true);

	await act(async () => {
		outcome = await latest.toggle("shared", true);
	});
	expect(outcome).toEqual({ success: true });
	await settle("retry acknowledged", () =>
		latest.apps.some((app) => app.id === "shared" && app.enabled)
	);
	expect(latest.toggleError).toBeNull();
	expect(posts(current)).toEqual([
		{ path: "/api/plugins/shared/disable", replied: "malformed" },
		{ path: "/api/plugins/shared/disable", replied: "unrelated" },
		{ path: "/api/plugins/shared/enable", replied: "shared" },
	]);
	await freshReload();
	expect(shown()).toEqual(coreTruth(current));
	expect(coreTruth(current)).toEqual([
		{ id: "shared", enabled: true, installed: true, installedVersion: "2.0.0" },
		{
			id: "unrelated",
			enabled: true,
			installed: true,
			installedVersion: "2.0.0",
		},
	]);
	expect(current.unknown).toEqual([]);
});

test("a wrong-app install completion rejects without stamping the foreign version and reloads Core's record", async () => {
	const current = startPeer([
		{ id: "shared", enabled: false, installed: false, installed_version: null },
		{
			id: "unrelated",
			enabled: true,
			installed: true,
			installed_version: "1.0.0",
		},
	]);
	peer = current;
	await mount();
	await settle("roster", () => latest.apps.length === 2);

	current.reply({ kind: "misdirect", to: "unrelated" });
	let failure: unknown;
	await act(async () => {
		await latest.install("shared").catch((error: unknown) => {
			failure = error;
		});
	});
	expect(failure).toBeInstanceOf(Error);
	expect((failure as Error).message).toBe(
		"Core confirmed a different app (unrelated); the app list was reloaded."
	);
	await settle("installed record reloaded", () =>
		latest.apps.some((app) => app.id === "shared" && app.installed)
	);
	expect(shown()).toEqual(coreTruth(current));
	expect(shown()).toEqual([
		{
			id: "shared",
			enabled: false,
			installed: true,
			installedVersion: "2.0.0",
		},
		{
			id: "unrelated",
			enabled: true,
			installed: true,
			installedVersion: "1.0.0",
		},
	]);

	let record: Awaited<ReturnType<typeof latest.install>> | undefined;
	await act(async () => {
		record = await latest.install("shared");
	});
	expect(record?.id).toBe("shared");
	expect(posts(current)).toEqual([
		{ path: "/api/plugins/shared/install", replied: "unrelated" },
		{ path: "/api/plugins/shared/install", replied: "shared" },
	]);
	await freshReload();
	expect(shown()).toEqual(coreTruth(current));
	expect(current.unknown).toEqual([]);
});
