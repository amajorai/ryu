import { expect, test } from "bun:test";
import {
	pluginDockSpec,
	pluginLiveActivity,
	pluginLiveSpec,
	pluginSidebarSpec,
	pluginStoreSpec,
} from "./plugin-contribution-specs.ts";
import { pluginValueSchema } from "./plugin-wire-values.ts";

test("sidebar decoder validates the full DSL and preserves valid future documents and identity", () => {
	const spec = pluginValueSchema.parse({
		context: { thread: "id" },
		create: {
			http: {
				method: "POST",
				path: "/api/ext/example/items",
				body: { title: "{{title}}" },
			},
			label: "New",
		},
		dateKey: "created_at",
		entity: { anchor: "conversation", idKey: "thread_id" },
		itemTarget: "/example/{{id}}",
		itemPreview: {
			description: "{{description}}",
			meta: [{ label: "Status", value: "{{status}}" }],
		},
		rowStyle: "messaging",
		source: {
			http: { path: "/api/ext/example/items" },
			items: "items",
			map: { id: "id", title: "name" },
		},
		future: JSON.parse('{"__proto__":{"kept":true}}'),
	});
	expect(pluginSidebarSpec({ spec }) === spec).toBe(true);
	expect(
		pluginSidebarSpec({
			spec: { source: { http: { method: "POST", path: "/api/items" } } },
		})
	).toBeUndefined();
	expect(pluginSidebarSpec({ spec: { context: { id: 4 } } })).toBeUndefined();
	expect(
		pluginSidebarSpec({
			spec: {
				create: {
					http: { method: "POST", path: "/api/items" },
					target: "/items",
				},
			},
		})
	).toBeUndefined();
});
test("store decoder validates graph, install, actions and raw source field maps", () => {
	const spec = pluginValueSchema.parse({
		detail: {
			graph: {
				nodes: "steps",
				edges: "links",
				nodeId: "id",
				edgeSource: "from",
				edgeTarget: "to",
			},
			source: { http: { method: "GET", path: "/api/templates/{{item.id}}" } },
		},
		install: {
			http: {
				method: "POST",
				path: "/api/templates/install",
				body: { id: "{{item.id}}" },
			},
		},
		itemActions: [
			{
				id: "inspect",
				label: "Inspect",
				style: "default",
				payload: { future: [null, true] },
			},
		],
		map: {
			id: "id",
			title: "name",
			installed: "installed",
			badgeTransform: "humanize",
		},
		source: { http: { path: "/api/templates" }, items: "templates" },
	});
	expect(pluginStoreSpec({ spec }) === spec).toBe(true);
	expect(
		pluginStoreSpec({ spec: { detail: { graph: { nodes: 4 } } } })
	).toBeUndefined();
	expect(
		pluginStoreSpec({ spec: { itemActions: [{ id: "missing-label" }] } })
	).toBeUndefined();
});
test("dock link codec checks every declared handler field while future panel metadata stays available", () => {
	const spec = {
		companion: "main",
		emptyText: "Loading",
		linkHandler: {
			method: "POST",
			path: "/api/ext/example/open",
			bodyKey: "url",
			schemes: ["example"],
		},
		future: { enabled: true },
	};
	expect(pluginDockSpec({ spec }) === spec).toBe(true);
	expect(
		pluginDockSpec({
			spec: {
				linkHandler: { path: "/api/ext/example/open", schemes: "example" },
			},
		})
	).toBeUndefined();
	expect(
		pluginDockSpec({
			spec: {
				linkHandler: {
					path: "/api/ext/example/open",
					schemes: ["example"],
					method: "GET",
				},
			},
		})
	).toBeUndefined();
});
test("live decoder validates audio, status mapping and source before exposing shared runtime types", () => {
	const spec = {
		audio: { src: "asset://audio", loop: true },
		map: { status: "state", statusMap: { queued: "waiting" } },
		source: { http: { path: "/api/jobs" } },
		target: "/jobs/{{item.id}}",
	};
	expect(pluginLiveSpec({ spec }) === spec).toBe(true);
	expect(pluginLiveSpec({ spec: { audio: { src: 3 } } })).toBeUndefined();
	expect(
		pluginLiveActivity({
			id: "jobs",
			title: "Jobs",
			http_policy: "core",
			spec: { audio: { src: "asset://audio" } },
		})
	).toMatchObject({
		http_policy: "core",
		spec: { audio: { src: "asset://audio" } },
	});
	expect(
		pluginLiveActivity({
			id: "jobs",
			title: "Jobs",
			http_policy: "unknown",
			spec: "invalid",
		})
	).toMatchObject({ http_policy: undefined, spec: undefined });
});
test("all opaque malformed spec representations use the existing missing-DSL fallback", () => {
	for (const spec of [null, true, 0, "invalid", [], [{}]]) {
		expect(pluginSidebarSpec({ spec })).toBeUndefined();
		expect(pluginStoreSpec({ spec })).toBeUndefined();
		expect(pluginDockSpec({ spec })).toBeUndefined();
		expect(pluginLiveSpec({ spec })).toBeUndefined();
	}
});
