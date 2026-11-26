// packages/core-client/src/monitors-path-id.test.ts
//
// Monitors and recipes are apps that Core serves through a mount. Core decodes
// the path tail of a mount once and matches the decoded path against the
// routes the app declares, so a slash that left the client as `%2F` is a
// separator again at Core. The id "data/purge?" of runMonitor reached POST
// /api/monitors/data/purge, and "alerts/7/ack?" acknowledged alert 7. The
// builders of both clients therefore build NO request for an id that holds a
// slash or a backslash, or that equals a one-segment static route of the
// manifest. The route names are read from the two manifests here.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiTarget } from "./client.ts";
import {
	ackAlert,
	deleteMonitor,
	getMonitor,
	listMonitorAlerts,
	listSnapshots,
	runMonitor,
	updateMonitor,
} from "./monitors.ts";
import { deleteRecipe, getRecipe, runRecipe } from "./recipes.ts";

const BASE = "http://core.test";
const HEX = "0123456789abcdef0123456789abcdef";
const MONITOR_ID = `mon_${HEX}`;
const RECIPE_NAME = "open-the-app";
/** Ids that leave the record at Core once the mount decodes them. */
const SEPARATOR_IDS = ["data/purge?", "alerts/7/ack?", "x\\run"];
const MONITOR_INPUT = {
	backend: "http" as const,
	check: { type: "uptime" as const },
	enabled: true,
	interval: "5m",
	name: "n",
	notify: [],
	url: "https://example.test",
};

/** A target whose stub fetch records every request and answers with an empty object. */
function recordingTarget(): { requests: string[]; target: ApiTarget } {
	const requests: string[] = [];
	const target: ApiTarget = {
		url: BASE,
		token: "node-token",
		fetch: (input, init) => {
			requests.push(`${init?.method ?? "GET"} ${String(input)}`);
			return Promise.resolve(Response.json({}));
		},
	};
	return { requests, target };
}

/** Run a builder and keep only what it asked the node for; the reply shape is not under test. */
async function requestsOf(
	call: (target: ApiTarget) => Promise<unknown>
): Promise<string[]> {
	const { requests, target } = recordingTarget();
	await Promise.resolve()
		.then(() => call(target))
		.catch(() => undefined);
	return requests;
}

interface MountBuilder {
	app: "monitors" | "recipes";
	call: (target: ApiTarget, id: string) => Promise<unknown>;
	minted: string;
	name: string;
	/** The one request the builder makes for an id that is not refused. */
	request: (id: string) => string;
}

const MOUNT_BUILDERS: MountBuilder[] = [
	{
		app: "monitors",
		name: "monitors getMonitor",
		minted: MONITOR_ID,
		request: (id) => `GET ${BASE}/api/monitors/${id}`,
		call: (target, id) => getMonitor(target, id),
	},
	{
		app: "monitors",
		name: "monitors updateMonitor",
		minted: MONITOR_ID,
		request: (id) => `PUT ${BASE}/api/monitors/${id}`,
		call: (target, id) => updateMonitor(target, id, MONITOR_INPUT),
	},
	{
		app: "monitors",
		name: "monitors deleteMonitor",
		minted: MONITOR_ID,
		request: (id) => `DELETE ${BASE}/api/monitors/${id}`,
		call: (target, id) => deleteMonitor(target, id),
	},
	{
		app: "monitors",
		name: "monitors runMonitor",
		minted: MONITOR_ID,
		request: (id) => `POST ${BASE}/api/monitors/${id}/run`,
		call: (target, id) => runMonitor(target, id),
	},
	{
		app: "monitors",
		name: "monitors listSnapshots",
		minted: MONITOR_ID,
		request: (id) => `GET ${BASE}/api/monitors/${id}/snapshots?limit=50`,
		call: (target, id) => listSnapshots(target, id),
	},
	{
		app: "monitors",
		name: "monitors listMonitorAlerts",
		minted: MONITOR_ID,
		request: (id) => `GET ${BASE}/api/monitors/${id}/alerts?limit=100`,
		call: (target, id) => listMonitorAlerts(target, id),
	},
	{
		app: "recipes",
		name: "recipes getRecipe",
		minted: RECIPE_NAME,
		request: (id) => `GET ${BASE}/api/recipes/${id}`,
		call: (target, id) => getRecipe(target, id),
	},
	{
		app: "recipes",
		name: "recipes deleteRecipe",
		minted: RECIPE_NAME,
		request: (id) => `DELETE ${BASE}/api/recipes/${id}`,
		call: (target, id) => deleteRecipe(target, id),
	},
	{
		app: "recipes",
		name: "recipes runRecipe",
		minted: RECIPE_NAME,
		request: (id) => `POST ${BASE}/api/recipes/${id}/run`,
		call: (target, id) => runRecipe(target, id, {}),
	},
];

describe("the clients of monitors and recipes build no request for an id with a separator", () => {
	for (const builder of MOUNT_BUILDERS) {
		for (const id of SEPARATOR_IDS) {
			test(`${builder.name} builds no request for the id ${id}`, async () => {
				expect(await requestsOf((target) => builder.call(target, id))).toEqual(
					[]
				);
			});
		}

		test(`${builder.name} builds its request unchanged for a minted id`, async () => {
			expect(
				await requestsOf((target) => builder.call(target, builder.minted))
			).toEqual([builder.request(builder.minted)]);
		});
	}

	test("monitors ackAlert keeps its numeric alert id", async () => {
		expect(await requestsOf((target) => ackAlert(target, 7))).toEqual([
			`POST ${BASE}/api/monitors/alerts/7/ack`,
		]);
	});
});

// A plain word needs no separator: `/alerts` of the monitors manifest is
// declared for every method and Core prefers a static route to `/:id`, so
// getMonitor("alerts") would read the alert list instead of a monitor. Each
// client refuses the one-segment static paths of its manifest.

interface Manifest {
	sidecars?: {
		http?: {
			mount?: string;
			public_mount?: string;
			routes?: { path: string }[];
		};
	}[];
}

/** `/alerts`: one static segment. */
const ONE_STATIC_SEGMENT = /^\/([^/:*]+)$/;
/** `/alerts`, `/alerts/stream`, `/record/start`: a static first segment. */
const STATIC_FIRST_SEGMENT = /^\/([^/:*]+)(?:\/|$)/;

/** The route patterns the manifest of an app declares under `/api/<app>`. */
function declaredPaths(app: string): string[] {
	const manifest = JSON.parse(
		readFileSync(
			join(
				import.meta.dir,
				"..",
				"..",
				"..",
				"apps-store",
				app,
				"manifest.json"
			),
			"utf8"
		)
	) as Manifest;
	const paths: string[] = [];
	for (const { http } of manifest.sidecars ?? []) {
		if ([http?.mount, http?.public_mount].includes(`/api/${app}`)) {
			paths.push(...(http?.routes ?? []).map((route) => route.path));
		}
	}
	return paths;
}

/** The first capture of `pattern` in each path that matches, sorted, once each. */
function capturedNames(paths: string[], pattern: RegExp): string[] {
	const names = new Set<string>();
	for (const path of paths) {
		const name = pattern.exec(path)?.[1];
		if (name) {
			names.add(name);
		}
	}
	return Array.from(names).sort();
}

/** Core's match of a declared pattern: `:name` is one non-empty segment. */
function routeMatches(pattern: string, path: string): boolean {
	const declared = pattern.split("/");
	const actual = path.split("/");
	return (
		declared.length === actual.length &&
		declared.every((segment, index) =>
			segment.startsWith(":") ? actual[index] !== "" : segment === actual[index]
		)
	);
}

const MOUNTED_APPS: {
	app: MountBuilder["app"];
	/** The list the client passes to the encoder; absent before the lists existed. */
	listed: () => Promise<readonly string[]>;
}[] = [
	{
		app: "monitors",
		listed: async () => (await import("./monitors.ts")).MONITOR_ROUTE_NAMES,
	},
	{
		app: "recipes",
		listed: async () => (await import("./recipes.ts")).RECIPE_ROUTE_NAMES,
	},
];

describe("the clients of monitors and recipes refuse the static route names of their manifest", () => {
	for (const { app, listed } of MOUNTED_APPS) {
		const paths = declaredPaths(app);
		const routeNames = capturedNames(paths, ONE_STATIC_SEGMENT);
		const builders = MOUNT_BUILDERS.filter((builder) => builder.app === app);

		test(`apps-store/${app}/manifest.json declares routes under /api/${app}`, () => {
			expect(paths.length).toBeGreaterThan(0);
		});

		// Both ways: a missing name leaves a static route reachable, a word the
		// manifest does not declare would refuse an id for no reason.
		test(`${app}.ts lists exactly the one-segment static paths of its manifest`, async () => {
			expect(Array.from(await listed()).sort()).toEqual(routeNames);
		});

		for (const name of routeNames) {
			for (const builder of builders) {
				test(`${builder.name} builds no request for the id ${name}`, async () => {
					expect(
						await requestsOf((target) => builder.call(target, name))
					).toEqual([]);
				});
			}
		}

		// `usage` of `/usage/providers` and `record` of `/record/start` are no
		// one-segment paths, so they are not refused. That holds only while no
		// builder ends in the rest of such a route.
		test(`${app} builders reach no static route with a first segment that is not refused`, async () => {
			const staticRoutes = paths.filter((path) =>
				STATIC_FIRST_SEGMENT.test(path)
			);
			const words = capturedNames(paths, STATIC_FIRST_SEGMENT).filter(
				(word) => !routeNames.includes(word)
			);
			expect(words.length).toBeGreaterThan(0);
			for (const word of words) {
				for (const builder of builders) {
					expect(
						await requestsOf((target) => builder.call(target, word))
					).toEqual([builder.request(word)]);
					const path =
						builder.request(word).split(`/api/${app}`)[1]?.split("?")[0] ?? "";
					expect(
						staticRoutes.filter((pattern) => routeMatches(pattern, path))
					).toEqual([]);
				}
			}
		});
	}
});

describe("the split of monitors.ts", () => {
	test("monitors.ts re-exports the wire schema of monitors-types.ts", async () => {
		const entry = await import("./monitors.ts");
		const types = await import("./monitors-types.ts");
		expect(entry.monitorNotifyTargetsInputSchema).toBe(
			types.monitorNotifyTargetsInputSchema
		);
	});
});
