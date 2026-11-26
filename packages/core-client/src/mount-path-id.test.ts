// packages/core-client/src/mount-path-id.test.ts
//
// Quests, meetings and teams are apps that Core serves through a mount. Core
// decodes the path tail of a mount once and matches the decoded path against
// the routes the app declares, so a slash that left the client as `%2F` is a
// separator again at Core and the request can match another route of the same
// app. The builders of the three clients therefore build NO request for an id
// that holds a slash or a backslash. Every builder is in the table, by name.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiTarget } from "./client.ts";
import {
	deleteMeeting,
	finalizeMeeting,
	getMeeting,
	getTranscript,
	renameMeeting,
	setMeetingIcon,
} from "./meetings.ts";
import { encodeMountPathId } from "./path-id.ts";
import {
	acceptSuggestion,
	completeQuest,
	deleteQuest,
	dismissQuest,
	dismissSuggestion,
	judgeQuest,
	pinQuest,
	updateQuest,
	useQuest,
} from "./quests.ts";
import {
	addTeamMember,
	deleteTeam,
	fetchTeam,
	removeTeamMember,
	updateTeam,
} from "./teams.ts";

const BASE = "http://core.test";
const HEX = "0123456789abcdef0123456789abcdef";
const QUEST_INPUT = { title: "t", completion_condition: "c" };
/** The id of the task: at Core it would read as `x` plus the segment `members`. */
const SLASH_ID = "x/members";
const BACKSLASH_ID = "x\\members";
const SEPARATOR_IDS = [SLASH_ID, BACKSLASH_ID, "recaps/consent", "a/b?c#d"];
/** The list of an id position that has no static route beside it. */
const NO_ROUTE_NAMES: readonly string[] = [];

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
	call: (target: ApiTarget, id: string) => Promise<unknown>;
	/** An id as the app mints it. */
	minted: string;
	name: string;
	/** The one request the builder makes for a minted id. */
	request: (id: string) => string;
}

const QUEST_ID = `quest_${HEX}`;
const MEETING_ID = `mtg_${HEX}`;
const TEAM_ID = `team_${HEX}`;
const AGENT_ID = `agent_${HEX}`;

const MOUNT_BUILDERS: MountBuilder[] = [
	{
		name: "quests useQuest",
		minted: QUEST_ID,
		request: (id) => `POST ${BASE}/api/quests/${id}/use`,
		call: (target, id) => useQuest(target, id),
	},
	{
		name: "quests pinQuest",
		minted: QUEST_ID,
		request: (id) => `POST ${BASE}/api/quests/${id}/pin`,
		call: (target, id) => pinQuest(target, id, true),
	},
	{
		name: "quests updateQuest",
		minted: QUEST_ID,
		request: (id) => `PUT ${BASE}/api/quests/${id}`,
		call: (target, id) => updateQuest(target, id, QUEST_INPUT),
	},
	{
		name: "quests deleteQuest",
		minted: QUEST_ID,
		request: (id) => `DELETE ${BASE}/api/quests/${id}`,
		call: (target, id) => deleteQuest(target, id),
	},
	{
		name: "quests completeQuest",
		minted: QUEST_ID,
		request: (id) => `POST ${BASE}/api/quests/${id}/complete`,
		call: (target, id) => completeQuest(target, id),
	},
	{
		name: "quests dismissQuest",
		minted: QUEST_ID,
		request: (id) => `POST ${BASE}/api/quests/${id}/dismiss`,
		call: (target, id) => dismissQuest(target, id),
	},
	{
		name: "quests acceptSuggestion",
		minted: QUEST_ID,
		request: (id) => `POST ${BASE}/api/quests/${id}/suggestion/accept`,
		call: (target, id) => acceptSuggestion(target, id),
	},
	{
		name: "quests dismissSuggestion",
		minted: QUEST_ID,
		request: (id) => `POST ${BASE}/api/quests/${id}/suggestion/dismiss`,
		call: (target, id) => dismissSuggestion(target, id),
	},
	{
		name: "meetings getMeeting",
		minted: MEETING_ID,
		request: (id) => `GET ${BASE}/api/meetings/${id}`,
		call: (target, id) => getMeeting(target, id),
	},
	{
		name: "meetings finalizeMeeting",
		minted: MEETING_ID,
		request: (id) => `POST ${BASE}/api/meetings/${id}/finalize`,
		call: (target, id) => finalizeMeeting(target, id),
	},
	{
		name: "meetings deleteMeeting",
		minted: MEETING_ID,
		request: (id) => `DELETE ${BASE}/api/meetings/${id}`,
		call: (target, id) => deleteMeeting(target, id),
	},
	{
		name: "meetings renameMeeting",
		minted: MEETING_ID,
		request: (id) => `POST ${BASE}/api/meetings/${id}/title`,
		call: (target, id) => renameMeeting(target, id, "t"),
	},
	{
		name: "meetings setMeetingIcon",
		minted: MEETING_ID,
		request: (id) => `POST ${BASE}/api/meetings/${id}/icon`,
		call: (target, id) => setMeetingIcon(target, id, null),
	},
	{
		name: "meetings getTranscript",
		minted: MEETING_ID,
		request: (id) => `GET ${BASE}/api/meetings/${id}/transcript`,
		call: (target, id) => getTranscript(target, id),
	},
	{
		name: "teams fetchTeam",
		minted: TEAM_ID,
		request: (id) => `GET ${BASE}/api/teams/${id}`,
		call: (target, id) => fetchTeam(target, id),
	},
	{
		name: "teams updateTeam",
		minted: TEAM_ID,
		request: (id) => `PATCH ${BASE}/api/teams/${id}`,
		call: (target, id) => updateTeam(target, id, {}),
	},
	{
		name: "teams deleteTeam",
		minted: TEAM_ID,
		request: (id) => `DELETE ${BASE}/api/teams/${id}`,
		call: (target, id) => deleteTeam(target, id),
	},
	{
		name: "teams addTeamMember (team id)",
		minted: TEAM_ID,
		request: (id) => `POST ${BASE}/api/teams/${id}/members`,
		call: (target, id) => addTeamMember(target, id, AGENT_ID),
	},
	{
		name: "teams removeTeamMember (team id)",
		minted: TEAM_ID,
		request: (id) => `DELETE ${BASE}/api/teams/${id}/members/${AGENT_ID}`,
		call: (target, id) => removeTeamMember(target, id, AGENT_ID),
	},
	{
		name: "teams removeTeamMember (agent id)",
		minted: AGENT_ID,
		request: (id) => `DELETE ${BASE}/api/teams/${TEAM_ID}/members/${id}`,
		call: (target, id) => removeTeamMember(target, TEAM_ID, id),
	},
];

describe("encodeMountPathId", () => {
	for (const id of [...SEPARATOR_IDS, "/", "\\", "../agents/a", "a\\..\\b"]) {
		test(`refuses ${JSON.stringify(id)}`, () => {
			expect(() => encodeMountPathId(id, NO_ROUTE_NAMES)).toThrow(
				"path separator"
			);
		});
	}

	test("refuses a dot segment as encodePathId does", () => {
		expect(() => encodeMountPathId(".", NO_ROUTE_NAMES)).toThrow("dot segment");
		expect(() => encodeMountPathId("..", NO_ROUTE_NAMES)).toThrow(
			"dot segment"
		);
	});

	test("leaves a minted id unchanged and encodes the other path characters", () => {
		for (const id of [QUEST_ID, MEETING_ID, TEAM_ID, AGENT_ID]) {
			expect(encodeMountPathId(id, NO_ROUTE_NAMES)).toBe(id);
		}
		expect(encodeMountPathId("a?c#d", NO_ROUTE_NAMES)).toBe("a%3Fc%23d");
		// An escape the caller wrote stays text: Core reads `%252F` back as `%2F`,
		// which is no separator, and refuses it (the count of slashes changes on
		// its second decode).
		expect(encodeMountPathId("x%2Fmembers", NO_ROUTE_NAMES)).toBe(
			"x%252Fmembers"
		);
	});

	test("refuses an id that equals a route name of the list", () => {
		for (const id of ["recaps", "stream"]) {
			expect(() => encodeMountPathId(id, ["recaps", "stream"])).toThrow(
				"route name"
			);
		}
	});

	test("encodes a word that only resembles a route name, and any word for an empty list", () => {
		for (const id of ["recap", "recaps2", "Recaps", "RECAPS", "recaps "]) {
			expect(encodeMountPathId(id, ["recaps"])).toBe(encodeURIComponent(id));
		}
		expect(encodeMountPathId("recaps", NO_ROUTE_NAMES)).toBe("recaps");
	});
});

describe("the clients of the mounted apps build no request for an id with a separator", () => {
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

	// judgeQuest reads the quest first and then asks for the verdict: two
	// requests for a minted id, none for an id with a separator.
	for (const id of SEPARATOR_IDS) {
		test(`quests judgeQuest builds no request for the id ${id}`, async () => {
			expect(await requestsOf((target) => judgeQuest(target, id))).toEqual([]);
		});
	}

	test("quests judgeQuest builds its two requests unchanged for a minted id", async () => {
		expect(await requestsOf((target) => judgeQuest(target, QUEST_ID))).toEqual([
			`GET ${BASE}/api/quests/${QUEST_ID}`,
			`POST ${BASE}/api/quests/${QUEST_ID}/judge`,
		]);
	});
});

// A plain word needs no separator: `DELETE /api/meetings/recaps` is the static
// route that deletes every recap, and Core prefers it to `DELETE /:id`. Each
// client therefore refuses the one-segment static paths of its app's manifest.
// The names below are read from the three manifests, so a static route added
// to a manifest fails here until the list of the client holds it.

interface Manifest {
	sidecars?: {
		http?: {
			mount?: string;
			public_mount?: string;
			routes?: { path: string }[];
		};
	}[];
}

/** `/recaps`: one static segment. */
const ONE_STATIC_SEGMENT = /^\/([^/:*]+)$/;
/** `/recaps`, `/recaps/consent`, `/ambient/chunk`: a static first segment. */
const STATIC_FIRST_SEGMENT = /^\/([^/:*]+)(?:\/|$)/;
/** `/:id/members/<static name>`: a static name beside the agent id of teams. */
const STATIC_MEMBER_SEGMENT = /^\/:[^/]+\/members\/[^/:*]+$/;
const AGENT_ID_BUILDER = "teams removeTeamMember (agent id)";

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

/** The builders that put the id of `app` right under its mount. */
function buildersOf(app: string): MountBuilder[] {
	return MOUNT_BUILDERS.filter(
		(builder) =>
			builder.name.startsWith(`${app} `) && builder.name !== AGENT_ID_BUILDER
	);
}

/**
 * For each id and builder of `app`: what the builder asked the node for, and
 * the one request that is its own. The two lists are equal when no id is
 * refused and none changes the request.
 */
async function askedAndOwn(
	app: string,
	ids: string[]
): Promise<{ asked: string[][]; own: string[][] }> {
	const asked: string[][] = [];
	const own: string[][] = [];
	for (const id of ids) {
		for (const builder of buildersOf(app)) {
			asked.push(await requestsOf((target) => builder.call(target, id)));
			own.push([builder.request(id)]);
		}
	}
	return { asked, own };
}

interface MountedApp {
	app: string;
	/** The list the client passes to the encoder; absent before the lists existed. */
	listed: () => Promise<readonly string[]>;
}

const MOUNTED_APPS: MountedApp[] = [
	{
		app: "quests",
		listed: async () => (await import("./quests.ts")).QUEST_ROUTE_NAMES,
	},
	{
		app: "meetings",
		listed: async () => (await import("./meetings.ts")).MEETING_ROUTE_NAMES,
	},
	{
		app: "teams",
		listed: async () => (await import("./teams.ts")).TEAM_ROUTE_NAMES,
	},
];

describe("the clients of the mounted apps refuse the static route names of their manifest", () => {
	for (const { app, listed } of MOUNTED_APPS) {
		const paths = declaredPaths(app);
		const routeNames = capturedNames(paths, ONE_STATIC_SEGMENT);

		test(`apps-store/${app}/manifest.json declares static routes under /api/${app}`, () => {
			expect(routeNames.length).toBeGreaterThan(0);
		});

		// Both ways: a missing name leaves a static route reachable, a word the
		// manifest does not declare would refuse an id for no reason.
		test(`${app}.ts lists exactly the one-segment static paths of its manifest`, async () => {
			expect(Array.from(await listed()).sort()).toEqual(routeNames);
		});

		for (const name of routeNames) {
			for (const builder of buildersOf(app)) {
				test(`${builder.name} builds no request for the id ${name}`, async () => {
					expect(
						await requestsOf((target) => builder.call(target, name))
					).toEqual([]);
				});
			}
		}

		test(`${app} builders build their request for a word that only resembles a route name`, async () => {
			const { asked, own } = await askedAndOwn(
				app,
				routeNames.flatMap((name) => [`${name}-1`, name.toUpperCase()])
			);
			expect(asked).toEqual(own);
		});

		// `ambient` of `/ambient/chunk` is no one-segment path, so it is not
		// refused. That holds only while no builder ends in the rest of such a
		// route: then the request of the builder matches its own route alone.
		test(`${app} builders reach no static route with a first segment that is not refused`, async () => {
			const staticRoutes = paths.filter((path) =>
				STATIC_FIRST_SEGMENT.test(path)
			);
			const words = capturedNames(paths, STATIC_FIRST_SEGMENT).filter(
				(word) => !routeNames.includes(word)
			);
			const { asked, own } = await askedAndOwn(app, words);
			expect(asked).toEqual(own);
			for (const word of words) {
				for (const builder of buildersOf(app)) {
					const path = builder.request(word).split(`/api/${app}`)[1] ?? "";
					expect(
						staticRoutes.filter((pattern) => routeMatches(pattern, path))
					).toEqual([]);
				}
			}
		});
	}

	for (const name of capturedNames(
		declaredPaths("quests"),
		ONE_STATIC_SEGMENT
	)) {
		test(`quests judgeQuest builds no request for the id ${name}`, async () => {
			expect(await requestsOf((target) => judgeQuest(target, name))).toEqual(
				[]
			);
		});
	}

	// The agent id of a team member is the one id position with no static route
	// beside it, so it takes an empty list and a route name is a valid agent id.
	test("apps-store/teams/manifest.json declares no static name after /:id/members/", () => {
		expect(
			declaredPaths("teams").filter((path) => STATIC_MEMBER_SEGMENT.test(path))
		).toEqual([]);
	});

	test("teams removeTeamMember (agent id) builds its request for an agent id that is a team route name", async () => {
		expect(
			await requestsOf((target) => removeTeamMember(target, TEAM_ID, "resolve"))
		).toEqual([`DELETE ${BASE}/api/teams/${TEAM_ID}/members/resolve`]);
	});
});

// A text check: a builder added to one of the three files later with the plain
// encoder would send `%2F` again. It reads the source, so it sees only a call
// written as `encodePathId(` or `encodeURIComponent(` in these files.
describe("the three clients use the mount encoder only", () => {
	const WEAKER_ENCODER = /\b(?:encodePathId|encodeURIComponent)\(/;
	const PATH_TEMPLATE = /`\/api\/(?:quests|meetings|teams)\/[^`]*\$\{/;

	for (const file of ["quests.ts", "meetings.ts", "teams.ts"]) {
		test(`${file} puts no id into a path with the plain encoder`, () => {
			const offending = readFileSync(join(import.meta.dir, file), "utf8")
				.split("\n")
				.filter(
					(line) => PATH_TEMPLATE.test(line) && WEAKER_ENCODER.test(line)
				);
			expect(offending).toEqual([]);
		});
	}
});
