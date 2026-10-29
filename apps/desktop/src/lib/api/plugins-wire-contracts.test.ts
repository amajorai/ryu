import { afterAll, beforeEach, expect, test } from "bun:test";
import {
	pluginDockSpec,
	pluginLiveActivity,
	pluginSidebarSpec,
	pluginStoreSpec,
} from "./plugin-contribution-specs.ts";
import {
	enableApp,
	fetchApps,
	fetchSidecarDetails,
	getPluginContributions,
	pluginHostInvoke,
	pluginHostInvokeStream,
	pluginThemeResponseSchema,
} from "./plugins.ts";

let response = Response.json({});
interface ReceivedRequest {
	body: string;
	headers: Headers;
	path: string;
}
const received: ReceivedRequest[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		received.push({
			headers: new Headers(request.headers),
			path: new URL(request.url).pathname,
			body: await request.text(),
		});
		return response;
	},
});
const target = {
	token: "fixture-node",
	url: `http://127.0.0.1:${server.port}`,
};
beforeEach(() => {
	received.length = 0;
});
afterAll(() => {
	server.stop(true);
});
const manifest = {
	built_in: false,
	enabled: false,
	id: "example",
	installed: true,
	installed_version: "1",
	local_only: false,
	name: "Example",
	permission_grants: [],
	runnables: [],
	sidecar_name: null,
	version: "1",
	windows_first: false,
};
test("manifest codec validates nested lifecycle fields and preserves future provenance fallback", async () => {
	response = Response.json({
		apps: [
			{
				...manifest,
				tier: "future_tier",
				runnables: [
					{
						id: "run",
						kind: "workflow",
						name: "Run",
						config: { steps: [], future: { nested: true } },
					},
				],
				future: { opaque: 1 },
			},
		],
	});
	const apps = await fetchApps(target);
	expect(apps[0]?.tier).toBeNull();
	expect(apps[0]?.runnables[0]?.config).toEqual({
		steps: [],
		future: { nested: true },
	});
	expect(received[0]?.headers.get("authorization")).toBe("Bearer fixture-node");
	response = Response.json({
		apps: [{ ...manifest, requires: { apps: [{ id: 1 }] } }],
	});
	await expect(fetchApps(target)).rejects.toThrow();
});
test("contribution envelopes retain malformed and future raw specs for their host fallback", async () => {
	response = Response.json({
		views: [
			{ id: "view", plugin: "example", view: "empty-state", spec: "invalid" },
		],
		sidebar_sections: [
			{ id: "sidebar", plugin: "example", title: "Sidebar", spec: [1] },
		],
		store_tabs: [
			{
				id: "store",
				plugin: "example",
				title: "Store",
				app_installed: true,
				app_enabled: true,
				spec: { future: { preserved: true } },
			},
		],
		dock_panels: [
			{
				id: "dock",
				plugin: "example",
				title: "Dock",
				panel: "future_panel",
				placement: "both",
				spec: false,
			},
		],
		live_activities: [
			{
				id: "activity",
				title: "Activity",
				plugin: "example",
				spec: "invalid",
				http_policy: "future_owner",
			},
		],
		companions: [
			{ id: "companion", label: "Companion", name: "Companion", mcpToolId: "" },
		],
	});
	const result = await getPluginContributions(target);
	expect(result.views[0]?.spec).toBe("invalid");
	expect(result.sidebar_sections[0]?.spec).toEqual([1]);
	expect(result.dock_panels[0]?.spec).toBe(false);
	expect(result.companions[0]?.mcpToolId).toBe("");
	expect(
		result.sidebar_sections[0] && pluginSidebarSpec(result.sidebar_sections[0])
	).toBeUndefined();
	expect(
		result.store_tabs[0] && pluginStoreSpec(result.store_tabs[0])
	).toMatchObject({ future: { preserved: true } });
	expect(
		result.dock_panels[0] && pluginDockSpec(result.dock_panels[0])
	).toBeUndefined();
	const activity = result.live_activities[0];
	expect(activity && pluginLiveActivity(activity)).toMatchObject({
		id: "activity",
		spec: undefined,
		http_policy: undefined,
	});
});
test("avatar contributions keep valid parts and drop unsafe or missing rows", async () => {
	const beanie = {
		id: "@acme/hats:beanie",
		label: "Beanie",
		plugin: "@acme/hats",
		target: "ghost",
		region: "headwear",
		shapes: [{ type: "path", d: "M12 2 Q18 -3 24 2 Z", fill: "palette.deep" }],
	};
	response = Response.json({
		avatar_accessories: [
			beanie,
			{
				...beanie,
				id: "@acme/hats:bad",
				shapes: [{ type: "circle", r: 1, fill: "url(#x)" }],
			},
		],
		avatar_styles: "not-a-list",
	});
	const result = await getPluginContributions(target);
	expect(result.avatar_accessories.map((row): string => row.id)).toEqual([
		beanie.id,
	]);
	expect(result.avatar_styles).toEqual([]);

	response = Response.json({});
	const older = await getPluginContributions(target);
	expect(older.avatar_accessories).toEqual([]);
	expect(older.avatar_styles).toEqual([]);
});
test("dependency errors decode all declared fields and future variants retain the generic explanation", async () => {
	response = Response.json(
		{
			message: "refused",
			dependency_error: {
				code: "blocked_by_dependents",
				plugin: "example",
				dependents: ["child"],
			},
		},
		{ status: 409 }
	);
	await expect(enableApp(target, "example")).rejects.toMatchObject({
		status: 409,
		dependencyError: { code: "blocked_by_dependents", dependents: ["child"] },
	});
	response = Response.json(
		{
			message: "refused",
			dependency_error: { code: "future_dependency_error", future: true },
		},
		{ status: 409 }
	);
	await expect(enableApp(target, "example")).rejects.toMatchObject({
		dependencyError: null,
		message: "This change conflicts with the current plugin dependencies.",
	});
});
test("host invocation checks JSON arguments and preserves complete future JSON reply data", async () => {
	const data = JSON.parse(
		'{"__proto__":{"kept":true},"nested":[1,null,false]}'
	);
	response = Response.json({ result: data, future: "metadata" });
	expect(
		await pluginHostInvoke(target, "@example/plugin", "future.method", data)
	).toEqual(data);
	expect(JSON.parse(received[0]?.body ?? "null")).toEqual({
		method: "future.method",
		args: data,
	});
	expect(received[0]?.path).toBe("/api/plugins/%40example%2Fplugin/host");
	const previous = received.length;
	await expect(
		pluginHostInvoke(target, "example", "method", () => undefined)
	).rejects.toThrow();
	expect(received).toHaveLength(previous);
});
test("host error codes honor the closed owner vocabulary and unknown codes use status fallback", async () => {
	response = Response.json(
		{ error: { code: "over_budget", message: "Budget reached" } },
		{ status: 429 }
	);
	await expect(
		pluginHostInvoke(target, "example", "method", {})
	).rejects.toMatchObject({ code: "over_budget", message: "Budget reached" });
	response = Response.json(
		{ error: { code: "future_error", message: "Refused" } },
		{ status: 403 }
	);
	await expect(
		pluginHostInvoke(target, "example", "method", {})
	).rejects.toMatchObject({ code: "denied", message: "Refused" });
});
test("SSE frames retain valid chunks, skip malformed deltas, and surface malformed error text with fallback", async () => {
	response = new Response(
		'data: {"type":"text-delta","delta":"one"}\n\ndata: {"type":"text-delta","delta":9}\n\ndata: {"type":"text-delta","delta":"two","future":true}\n\ndata: [DONE]\n\n'
	);
	const chunks: string[] = [];
	await pluginHostInvokeStream(
		target,
		"example",
		{ prompt: "hello" },
		{ onChunk: (delta) => chunks.push(delta) }
	);
	expect(chunks).toEqual(["one", "two"]);
	response = new Response('data: {"type":"error","errorText":9}\n\n');
	await expect(
		pluginHostInvokeStream(
			target,
			"example",
			{ prompt: "hello" },
			{ onChunk: () => undefined }
		)
	).rejects.toMatchObject({
		code: "server_error",
		message: "agent stream error",
	});
});
test("sidecar details validate every optional metric before exposing typed records", async () => {
	response = Response.json({
		sidecars: [
			{
				name: "fixture",
				running: true,
				pid: 5,
				memory_bytes: 10,
				cpu_percent: 0.5,
				future: { kept: true },
			},
		],
	});
	expect(await fetchSidecarDetails(target)).toEqual({
		fixture: {
			running: true,
			pid: 5,
			memoryBytes: 10,
			cpuPercent: 0.5,
			sandbox: null,
		},
	});
	response = Response.json({
		sidecars: [
			{
				name: "@acme/app/svc",
				running: true,
				sandbox: {
					mode: "enforce",
					backend: "landlock",
					enforced: true,
					fs_restricted: true,
				},
			},
		],
	});
	expect((await fetchSidecarDetails(target))["@acme/app/svc"]?.sandbox).toEqual(
		{
			mode: "enforce",
			backend: "landlock",
			enforced: true,
			fsRestricted: true,
			detail: null,
		}
	);
	response = Response.json({
		sidecars: [{ name: "fixture", running: true, pid: "5" }],
	});
	await expect(fetchSidecarDetails(target)).rejects.toThrow();
});

test("Core unknown manifest targets survive normalization without becoming request surfaces", async () => {
	response = Response.json({
		apps: [{ ...manifest, targets: ["desktop", "unknown"] }],
	});
	const apps = await fetchApps(target);
	expect(apps[0]?.targets).toEqual(["desktop", "unknown"]);
	expect(received[0]?.headers.get("X-Ryu-Surface")).toBe("desktop");
});

test("theme tokens preserve own prototype-named keys and validate their values", () => {
	const tokens = JSON.parse('{"__proto__":"blue","--background":"#fff"}');
	const theme = {
		id: "future-theme",
		label: "Future theme",
		mode: "light",
		plugin: "example",
		preview: { bg: "#fff", surface: "#eee", primary: "blue", text: "#000" },
		tokens,
	};
	const parsed = pluginThemeResponseSchema.parse(theme);
	expect(parsed.tokens).toBe(tokens);
	expect(Object.keys(parsed.tokens)).toEqual(["__proto__", "--background"]);
	expect(
		pluginThemeResponseSchema.safeParse({
			...theme,
			tokens: JSON.parse('{"__proto__":42,"--background":"#fff"}'),
		}).success
	).toBe(false);
});
