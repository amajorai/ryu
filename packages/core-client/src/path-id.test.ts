// packages/core-client/src/path-id.test.ts
//
// An id from an app frame, a model or any other caller must stay inside one path
// segment of the Core URL, whatever the HTTP client of the runtime does with
// `..` afterwards. Every builder that encodes its id is in the table below, by
// name. The builders of the files split for SA-15 part 2 (workflows, monitors,
// spaces) have their own tests (workflows-path-id.test.ts and the others); the
// block at the end keeps their traversal cases.

import { describe, expect, test } from "bun:test";
import { approveApproval, getApproval, rejectApproval } from "./approvals.ts";
import { type ApiTarget, apiUrl } from "./client.ts";
import { cancelDownload, clearDownload } from "./downloads.ts";
import { clearGoal, getGoal, pauseGoal, resumeGoal, setGoal } from "./goals.ts";
import { revokeDevice, updateDevice } from "./hardware.ts";
import {
	deleteMeeting,
	finalizeMeeting,
	getMeeting,
	getTranscript,
	renameMeeting,
	setMeetingIcon,
} from "./meetings.ts";
import { getMonitor, runMonitor } from "./monitors.ts";
import { ackNotification, markNotificationRead } from "./notifications.ts";
import { assertNoDotSegment, encodePathId } from "./path-id.ts";
import {
	acceptSuggestion,
	completeQuest,
	deleteQuest,
	dismissQuest,
	dismissSuggestion,
	pinQuest,
	updateQuest,
	useQuest,
} from "./quests.ts";
import { deleteJob } from "./schedules.ts";
import { listSessionsForConversation } from "./sessions.ts";
import { searchSpace } from "./spaces.ts";
import {
	addTeamMember,
	deleteTeam,
	fetchTeam,
	removeTeamMember,
	updateTeam,
} from "./teams.ts";
import { fetchWorkflow, getWorkflowRun, runWorkflow } from "./workflows.ts";

const BASE = "http://core.test";
const HOSTILE_ID = "a/b?c#d";
const ENCODED_ID = "a%2Fb%3Fc%23d";
const TRAVERSAL_ID = "../agents/a";
// Quests, meetings and teams are served through a mount, where Core decodes
// the path once, so their builders refuse a separator (mount-path-id.test.ts).
// Their hostile id here holds the other two path characters only.
const MOUNT_BUILDER = /^(?:quests|meetings|teams) /;
const MOUNT_HOSTILE_ID = "a?c#d";
const MOUNT_ENCODED_ID = "a%3Fc%23d";
const QUEST_INPUT = { title: "t", completion_condition: "c" };

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

interface EncodedBuilder {
	call: (target: ApiTarget, id: string) => Promise<unknown>;
	method: string;
	name: string;
	path: (segment: string) => string;
}

const ENCODED_BUILDERS: EncodedBuilder[] = [
	{
		name: "quests useQuest",
		method: "POST",
		path: (id) => `/api/quests/${id}/use`,
		call: (target, id) => useQuest(target, id),
	},
	{
		name: "quests pinQuest",
		method: "POST",
		path: (id) => `/api/quests/${id}/pin`,
		call: (target, id) => pinQuest(target, id, true),
	},
	{
		name: "quests updateQuest",
		method: "PUT",
		path: (id) => `/api/quests/${id}`,
		call: (target, id) => updateQuest(target, id, QUEST_INPUT),
	},
	{
		name: "quests deleteQuest",
		method: "DELETE",
		path: (id) => `/api/quests/${id}`,
		call: (target, id) => deleteQuest(target, id),
	},
	{
		name: "quests completeQuest",
		method: "POST",
		path: (id) => `/api/quests/${id}/complete`,
		call: (target, id) => completeQuest(target, id),
	},
	{
		name: "quests dismissQuest",
		method: "POST",
		path: (id) => `/api/quests/${id}/dismiss`,
		call: (target, id) => dismissQuest(target, id),
	},
	{
		name: "quests acceptSuggestion",
		method: "POST",
		path: (id) => `/api/quests/${id}/suggestion/accept`,
		call: (target, id) => acceptSuggestion(target, id),
	},
	{
		name: "quests dismissSuggestion",
		method: "POST",
		path: (id) => `/api/quests/${id}/suggestion/dismiss`,
		call: (target, id) => dismissSuggestion(target, id),
	},
	{
		name: "approvals getApproval",
		method: "GET",
		path: (id) => `/api/approvals/${id}`,
		call: (target, id) => getApproval(target, id),
	},
	{
		name: "approvals approveApproval",
		method: "POST",
		path: (id) => `/api/approvals/${id}/approve`,
		call: (target, id) => approveApproval(target, id),
	},
	{
		name: "approvals rejectApproval",
		method: "POST",
		path: (id) => `/api/approvals/${id}/reject`,
		call: (target, id) => rejectApproval(target, id),
	},
	{
		name: "notifications markNotificationRead",
		method: "POST",
		path: (id) => `/api/notifications/${id}/read`,
		call: (target, id) => markNotificationRead(target, id),
	},
	{
		name: "notifications ackNotification",
		method: "POST",
		path: (id) => `/api/notifications/${id}/ack`,
		call: (target, id) => ackNotification(target, id),
	},
	{
		name: "meetings getMeeting",
		method: "GET",
		path: (id) => `/api/meetings/${id}`,
		call: (target, id) => getMeeting(target, id),
	},
	{
		name: "meetings finalizeMeeting",
		method: "POST",
		path: (id) => `/api/meetings/${id}/finalize`,
		call: (target, id) => finalizeMeeting(target, id),
	},
	{
		name: "meetings deleteMeeting",
		method: "DELETE",
		path: (id) => `/api/meetings/${id}`,
		call: (target, id) => deleteMeeting(target, id),
	},
	{
		name: "meetings renameMeeting",
		method: "POST",
		path: (id) => `/api/meetings/${id}/title`,
		call: (target, id) => renameMeeting(target, id, "t"),
	},
	{
		name: "meetings setMeetingIcon",
		method: "POST",
		path: (id) => `/api/meetings/${id}/icon`,
		call: (target, id) => setMeetingIcon(target, id, null),
	},
	{
		name: "meetings getTranscript",
		method: "GET",
		path: (id) => `/api/meetings/${id}/transcript`,
		call: (target, id) => getTranscript(target, id),
	},
	{
		name: "goals getGoal",
		method: "GET",
		path: (id) => `/api/conversations/${id}/goal`,
		call: (target, id) => getGoal(target, id),
	},
	{
		name: "goals setGoal",
		method: "PUT",
		path: (id) => `/api/conversations/${id}/goal`,
		call: (target, id) => setGoal(target, id, "g"),
	},
	{
		name: "goals clearGoal",
		method: "DELETE",
		path: (id) => `/api/conversations/${id}/goal`,
		call: (target, id) => clearGoal(target, id),
	},
	{
		name: "goals pauseGoal",
		method: "POST",
		path: (id) => `/api/conversations/${id}/goal/pause`,
		call: (target, id) => pauseGoal(target, id),
	},
	{
		name: "goals resumeGoal",
		method: "POST",
		path: (id) => `/api/conversations/${id}/goal/resume`,
		call: (target, id) => resumeGoal(target, id),
	},
	{
		name: "hardware updateDevice",
		method: "PATCH",
		path: (id) => `/api/hardware/devices/${id}`,
		call: (target, id) => updateDevice(target, id, {}),
	},
	{
		name: "hardware revokeDevice",
		method: "DELETE",
		path: (id) => `/api/hardware/devices/${id}`,
		call: (target, id) => revokeDevice(target, id),
	},
	{
		name: "downloads cancelDownload",
		method: "POST",
		path: (id) => `/api/downloads/${id}/cancel`,
		call: (target, id) => cancelDownload(target, id),
	},
	{
		name: "downloads clearDownload",
		method: "DELETE",
		path: (id) => `/api/downloads/${id}`,
		call: (target, id) => clearDownload(target, id),
	},
	{
		name: "schedules deleteJob",
		method: "DELETE",
		path: (id) => `/heartbeat/jobs/${id}`,
		call: (target, id) => deleteJob(target, id),
	},
	{
		name: "sessions listSessionsForConversation",
		method: "GET",
		path: (id) => `/api/conversations/${id}/sessions`,
		call: (target, id) => listSessionsForConversation(target, id),
	},
	{
		name: "teams fetchTeam",
		method: "GET",
		path: (id) => `/api/teams/${id}`,
		call: (target, id) => fetchTeam(target, id),
	},
	{
		name: "teams updateTeam",
		method: "PATCH",
		path: (id) => `/api/teams/${id}`,
		call: (target, id) => updateTeam(target, id, {}),
	},
	{
		name: "teams deleteTeam",
		method: "DELETE",
		path: (id) => `/api/teams/${id}`,
		call: (target, id) => deleteTeam(target, id),
	},
	{
		name: "teams addTeamMember (team id)",
		method: "POST",
		path: (id) => `/api/teams/${id}/members`,
		call: (target, id) => addTeamMember(target, id, "agent"),
	},
	{
		name: "teams removeTeamMember (team id)",
		method: "DELETE",
		path: (id) => `/api/teams/${id}/members/agent`,
		call: (target, id) => removeTeamMember(target, id, "agent"),
	},
	{
		name: "teams removeTeamMember (agent id)",
		method: "DELETE",
		path: (id) => `/api/teams/team/members/${id}`,
		call: (target, id) => removeTeamMember(target, "team", id),
	},
];

describe("a hostile id stays inside one path segment", () => {
	test("getApproval with ../agents/a asks for a path under /api/approvals/", async () => {
		const requests = await requestsOf((target) =>
			getApproval(target, TRAVERSAL_ID)
		);
		expect(requests).toEqual([`GET ${BASE}/api/approvals/..%2Fagents%2Fa`]);
		const sent = new URL(requests[0]?.split(" ")[1] ?? BASE);
		expect(sent.pathname).toBe("/api/approvals/..%2Fagents%2Fa");
	});

	test("deleteQuest with ../agents/a builds no request", async () => {
		expect(
			await requestsOf((target) => deleteQuest(target, TRAVERSAL_ID))
		).toEqual([]);
	});

	for (const builder of ENCODED_BUILDERS) {
		const mount = MOUNT_BUILDER.test(builder.name);
		const hostile = mount ? MOUNT_HOSTILE_ID : HOSTILE_ID;
		const encoded = mount ? MOUNT_ENCODED_ID : ENCODED_ID;

		test(`${builder.name} encodes ${hostile}`, async () => {
			const requests = await requestsOf((target) =>
				builder.call(target, hostile)
			);
			expect(requests).toEqual([
				`${builder.method} ${BASE}${builder.path(encoded)}`,
			]);
			const sent = new URL(requests[0]?.split(" ")[1] ?? BASE);
			expect(sent.pathname).toBe(builder.path(encoded));
			expect(sent.search).toBe("");
			expect(sent.hash).toBe("");
		});

		test(`${builder.name} sends nothing for the id ..`, async () => {
			expect(await requestsOf((target) => builder.call(target, ".."))).toEqual(
				[]
			);
		});
	}

	test("a plain id is sent unchanged", async () => {
		const id = "quest_0123456789abcdef0123456789abcdef";
		expect(await requestsOf((target) => completeQuest(target, id))).toEqual([
			`POST ${BASE}/api/quests/${id}/complete`,
		]);
		expect(encodePathId("run-0123_abc")).toBe("run-0123_abc");
	});
});

describe("apiUrl refuses a path with a dot segment", () => {
	const target: ApiTarget = { url: `${BASE}/`, token: null };

	for (const path of [
		"/api/quests/../agents/a",
		"/api/x/../y",
		"/api/x/../y?path=a#b",
		"/workflows/../api/agents/a?/run",
		"/api/spaces/../../api/agents/a#/search",
		"/api/quests/./complete",
		"/api/quests/..",
		"/api/quests/%2e%2e/agents/a",
		"/api/quests/.%2E/agents/a",
		"/api/quests/%2e/complete",
		"/api/quests/.\t./complete",
		"/api/quests/.\n.\r/complete",
		"/api/quests\\..\\agents\\a",
		"../agents/a",
	]) {
		test(`refuses ${JSON.stringify(path)}`, () => {
			expect(() => apiUrl(target, path)).toThrow("dot segment");
			expect(() => assertNoDotSegment(path)).toThrow("dot segment");
		});
	}

	for (const [path, url] of [
		["/api/quests/quest_1/complete", `${BASE}/api/quests/quest_1/complete`],
		["api/health", `${BASE}/api/health`],
		["/api/files?path=../notes/a.md", `${BASE}/api/files?path=../notes/a.md`],
		// Only the part before "?" and "#" is judged: a dot segment in a query or
		// a fragment (a file path sent as a parameter) is not a path segment.
		["/api/files?path=../a", `${BASE}/api/files?path=../a`],
		["/api/files?dir=a/../b&x=./c", `${BASE}/api/files?dir=a/../b&x=./c`],
		["/api/files#../a", `${BASE}/api/files#../a`],
		["/api/files?path=..#../a/./b", `${BASE}/api/files?path=..#../a/./b`],
		["/api/quests/..%2Fagents%2Fa", `${BASE}/api/quests/..%2Fagents%2Fa`],
		["/api/models/v1.2/..hidden/a.b", `${BASE}/api/models/v1.2/..hidden/a.b`],
		["/api/ext/@ryu/quests/.../x", `${BASE}/api/ext/@ryu/quests/.../x`],
	] as const) {
		test(`keeps ${path}`, () => {
			expect(apiUrl(target, path)).toBe(url);
		});
	}
});

describe("the builders of the split files cannot leave their route", () => {
	// workflows and spaces are Core's own routes: the id is encoded and stays in
	// its segment. monitors is a mount: its builders refuse a separator and send
	// nothing (monitors-path-id.test.ts).
	const SPLIT_BUILDERS: Array<{
		call: (target: ApiTarget, id: string) => Promise<unknown>;
		name: string;
		request: ((segment: string) => string) | null;
	}> = [
		{
			name: "workflows runWorkflow",
			call: (target, id) => runWorkflow(target, id, {}),
			request: (segment) => `POST ${BASE}/workflows/${segment}/run`,
		},
		{
			name: "workflows fetchWorkflow",
			call: (target, id) => fetchWorkflow(target, id),
			request: (segment) => `GET ${BASE}/workflows/${segment}`,
		},
		{
			name: "workflows getWorkflowRun",
			call: (target, id) => getWorkflowRun(target, id),
			request: (segment) => `GET ${BASE}/workflows/runs/${segment}`,
		},
		{
			name: "spaces searchSpace",
			call: (target, id) => searchSpace(target, id, "q"),
			request: (segment) => `POST ${BASE}/api/spaces/${segment}/search`,
		},
		{
			name: "monitors getMonitor",
			call: (target, id) => getMonitor(target, id),
			request: null,
		},
		{
			name: "monitors runMonitor",
			call: (target, id) => runMonitor(target, id),
			request: null,
		},
	];

	for (const builder of SPLIT_BUILDERS) {
		for (const id of [TRAVERSAL_ID, "../../api/agents/a?", "%2e%2e/agents/a"]) {
			const expected = builder.request
				? [builder.request(encodeURIComponent(id))]
				: [];
			test(`${builder.name} keeps ${id} out of every other route`, async () => {
				expect(await requestsOf((target) => builder.call(target, id))).toEqual(
					expected
				);
			});
		}
	}
});
