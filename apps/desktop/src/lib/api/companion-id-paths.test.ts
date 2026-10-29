// apps/desktop/src/lib/api/companion-id-paths.test.ts
//
// Companion frames pass record IDs to the host, and the host-direct clients
// below put them in Core URL paths fetched with the node bearer. Each ID must
// stay one path segment: `../`, `%2e%2e`, `?` and `#` must not move the request
// onto another Core route, and a bare `.` or `..` is refused before any fetch.

import { describe, expect, test } from "bun:test";
import { approveApproval, getApproval, rejectApproval } from "./approvals.ts";
import type { ApiTarget } from "./client.ts";
import {
	deleteMeeting,
	finalizeMeeting,
	getMeeting,
	getTranscript,
	renameMeeting,
	setMeetingIcon,
} from "./meetings.ts";
import {
	deleteMonitor,
	getMonitor,
	listMonitorAlerts,
	listSnapshots,
	type MonitorInput,
	runMonitor,
	updateMonitor,
} from "./monitors.ts";
import {
	ackNotification,
	archiveNotification,
	markNotificationRead,
	unarchiveNotification,
} from "./notifications.ts";
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
	distributeSkill,
	getSkillSource,
	getSkillVersionSource,
	listSkillVersions,
	restoreSkillVersion,
	snapshotSkill,
	updateSkill,
} from "./skills.ts";
import { searchSpace } from "./spaces.ts";
import {
	createWorkflowVersion,
	deleteWorkflow,
	fetchWorkflow,
	fetchWorkflowTemplate,
	getWorkflowRun,
	getWorkflowVersionDefinition,
	listWorkflowVersions,
	restoreWorkflowVersion,
	resumeWorkflow,
	runWorkflow,
} from "./workflows.ts";

interface PathOperation {
	call: (target: ApiTarget, id: string) => Promise<unknown>;
	method: string;
	name: string;
	/** The request path once the ID has become `segment`. */
	path: (segment: string) => string;
	search?: string;
}

const monitorInput: MonitorInput = {
	backend: "http",
	check: { type: "uptime" },
	enabled: true,
	interval: "5m",
	name: "Fixture",
	notify: [],
	url: "https://example.test",
};
const questInput = { completion_condition: "done", title: "Fixture" };

const operations: PathOperation[] = [
	{
		name: "getMonitor",
		method: "GET",
		path: (id) => `/api/monitors/${id}`,
		call: getMonitor,
	},
	{
		name: "updateMonitor",
		method: "PUT",
		path: (id) => `/api/monitors/${id}`,
		call: (target, id) => updateMonitor(target, id, monitorInput),
	},
	{
		name: "deleteMonitor",
		method: "DELETE",
		path: (id) => `/api/monitors/${id}`,
		call: deleteMonitor,
	},
	{
		name: "runMonitor",
		method: "POST",
		path: (id) => `/api/monitors/${id}/run`,
		call: runMonitor,
	},
	{
		name: "listSnapshots",
		method: "GET",
		path: (id) => `/api/monitors/${id}/snapshots`,
		search: "?limit=50",
		call: (target, id) => listSnapshots(target, id),
	},
	{
		name: "listMonitorAlerts",
		method: "GET",
		path: (id) => `/api/monitors/${id}/alerts`,
		search: "?limit=100",
		call: (target, id) => listMonitorAlerts(target, id),
	},
	{
		name: "useQuest",
		method: "POST",
		path: (id) => `/api/quests/${id}/use`,
		call: (target, id) => useQuest(target, id),
	},
	{
		name: "pinQuest",
		method: "POST",
		path: (id) => `/api/quests/${id}/pin`,
		call: (target, id) => pinQuest(target, id, true),
	},
	{
		name: "updateQuest",
		method: "PUT",
		path: (id) => `/api/quests/${id}`,
		call: (target, id) => updateQuest(target, id, questInput),
	},
	{
		name: "deleteQuest",
		method: "DELETE",
		path: (id) => `/api/quests/${id}`,
		call: deleteQuest,
	},
	{
		name: "completeQuest",
		method: "POST",
		path: (id) => `/api/quests/${id}/complete`,
		call: completeQuest,
	},
	{
		name: "dismissQuest",
		method: "POST",
		path: (id) => `/api/quests/${id}/dismiss`,
		call: dismissQuest,
	},
	{
		name: "acceptSuggestion",
		method: "POST",
		path: (id) => `/api/quests/${id}/suggestion/accept`,
		call: acceptSuggestion,
	},
	{
		name: "dismissSuggestion",
		method: "POST",
		path: (id) => `/api/quests/${id}/suggestion/dismiss`,
		call: dismissSuggestion,
	},
	{
		name: "distributeSkill",
		method: "POST",
		path: (id) => `/api/skills/${id}/distribute`,
		call: (target, id) =>
			distributeSkill(target, id, { remember: false, targetIds: [] }),
	},
	{
		name: "getSkillSource",
		method: "GET",
		path: (id) => `/api/skills/${id}/source`,
		call: getSkillSource,
	},
	{
		name: "updateSkill",
		method: "PUT",
		path: (id) => `/api/skills/${id}`,
		call: (target, id) =>
			updateSkill(target, id, { body: "Fixture", name: "fixture" }),
	},
	{
		name: "listSkillVersions",
		method: "GET",
		path: (id) => `/api/skills/${id}/versions`,
		call: listSkillVersions,
	},
	{
		name: "snapshotSkill",
		method: "POST",
		path: (id) => `/api/skills/${id}/versions`,
		call: snapshotSkill,
	},
	{
		name: "getSkillVersionSource (skill id)",
		method: "GET",
		path: (id) => `/api/skills/${id}/versions/v1`,
		call: (target, id) => getSkillVersionSource(target, id, "v1"),
	},
	{
		name: "getSkillVersionSource (version id)",
		method: "GET",
		path: (id) => `/api/skills/skill-1/versions/${id}`,
		call: (target, id) => getSkillVersionSource(target, "skill-1", id),
	},
	{
		name: "restoreSkillVersion (skill id)",
		method: "POST",
		path: (id) => `/api/skills/${id}/versions/v1/restore`,
		call: (target, id) => restoreSkillVersion(target, id, "v1"),
	},
	{
		name: "restoreSkillVersion (version id)",
		method: "POST",
		path: (id) => `/api/skills/skill-1/versions/${id}/restore`,
		call: (target, id) => restoreSkillVersion(target, "skill-1", id),
	},
	{
		name: "getMeeting",
		method: "GET",
		path: (id) => `/api/meetings/${id}`,
		call: getMeeting,
	},
	{
		name: "finalizeMeeting",
		method: "POST",
		path: (id) => `/api/meetings/${id}/finalize`,
		call: finalizeMeeting,
	},
	{
		name: "deleteMeeting",
		method: "DELETE",
		path: (id) => `/api/meetings/${id}`,
		call: deleteMeeting,
	},
	{
		name: "renameMeeting",
		method: "POST",
		path: (id) => `/api/meetings/${id}/title`,
		call: (target, id) => renameMeeting(target, id, "Fixture"),
	},
	{
		name: "setMeetingIcon",
		method: "POST",
		path: (id) => `/api/meetings/${id}/icon`,
		call: (target, id) => setMeetingIcon(target, id, null),
	},
	{
		name: "getTranscript",
		method: "GET",
		path: (id) => `/api/meetings/${id}/transcript`,
		call: getTranscript,
	},
	{
		name: "fetchWorkflow",
		method: "GET",
		path: (id) => `/workflows/${id}`,
		call: fetchWorkflow,
	},
	{
		name: "deleteWorkflow",
		method: "DELETE",
		path: (id) => `/workflows/${id}`,
		call: deleteWorkflow,
	},
	{
		name: "runWorkflow",
		method: "POST",
		path: (id) => `/workflows/${id}/run`,
		call: (target, id) => runWorkflow(target, id, {}),
	},
	{
		name: "getWorkflowRun",
		method: "GET",
		path: (id) => `/workflows/runs/${id}`,
		call: getWorkflowRun,
	},
	{
		name: "resumeWorkflow",
		method: "POST",
		path: (id) => `/workflows/runs/${id}/resume`,
		call: (target, id) => resumeWorkflow(target, id, "ok"),
	},
	{
		name: "fetchWorkflowTemplate",
		method: "GET",
		path: (id) => `/api/workflows/catalog/${id}`,
		call: fetchWorkflowTemplate,
	},
	{
		name: "listWorkflowVersions",
		method: "GET",
		path: (id) => `/workflows/${id}/versions`,
		call: listWorkflowVersions,
	},
	{
		name: "getWorkflowVersionDefinition (workflow id)",
		method: "GET",
		path: (id) => `/workflows/${id}/versions/v1`,
		call: (target, id) => getWorkflowVersionDefinition(target, id, "v1"),
	},
	{
		name: "getWorkflowVersionDefinition (version id)",
		method: "GET",
		path: (id) => `/workflows/wf1/versions/${id}`,
		call: (target, id) => getWorkflowVersionDefinition(target, "wf1", id),
	},
	{
		name: "createWorkflowVersion",
		method: "POST",
		path: (id) => `/workflows/${id}/versions`,
		call: (target, id) => createWorkflowVersion(target, id),
	},
	{
		name: "restoreWorkflowVersion (workflow id)",
		method: "POST",
		path: (id) => `/workflows/${id}/versions/v1/restore`,
		call: (target, id) => restoreWorkflowVersion(target, id, "v1"),
	},
	{
		name: "restoreWorkflowVersion (version id)",
		method: "POST",
		path: (id) => `/workflows/wf1/versions/${id}/restore`,
		call: (target, id) => restoreWorkflowVersion(target, "wf1", id),
	},
	{
		name: "getApproval",
		method: "GET",
		path: (id) => `/api/approvals/${id}`,
		call: getApproval,
	},
	{
		name: "approveApproval",
		method: "POST",
		path: (id) => `/api/approvals/${id}/approve`,
		call: (target, id) => approveApproval(target, id),
	},
	{
		name: "rejectApproval",
		method: "POST",
		path: (id) => `/api/approvals/${id}/reject`,
		call: (target, id) => rejectApproval(target, id),
	},
	{
		name: "markNotificationRead",
		method: "POST",
		path: (id) => `/api/notifications/${id}/read`,
		call: markNotificationRead,
	},
	{
		name: "archiveNotification",
		method: "POST",
		path: (id) => `/api/notifications/${id}/archive`,
		call: archiveNotification,
	},
	{
		name: "unarchiveNotification",
		method: "POST",
		path: (id) => `/api/notifications/${id}/unarchive`,
		call: unarchiveNotification,
	},
	{
		name: "ackNotification",
		method: "POST",
		path: (id) => `/api/notifications/${id}/ack`,
		call: ackNotification,
	},
	{
		name: "searchSpace",
		method: "POST",
		path: (id) => `/api/spaces/${id}/search`,
		call: (target, id) => searchSpace(target, id, "query"),
	},
];

interface RecordedRequest {
	method: string;
	pathname: string;
	search: string;
}

/** Run `call` and return what it rejected with, or `null` on success. The
 *  fixture server answers `{}`, so response parsing may legitimately fail; these
 *  tests only pin where the request went. */
async function rejection(call: () => Promise<unknown>): Promise<unknown> {
	try {
		await call();
		return null;
	} catch (error) {
		return error;
	}
}

describe("companion-supplied record IDs stay inside one Core path segment", () => {
	test("hostile IDs stay one encoded segment and normal IDs are unchanged", async () => {
		const requests: RecordedRequest[] = [];
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				const url = new URL(request.url);
				requests.push({
					method: request.method,
					pathname: url.pathname,
					search: url.search,
				});
				return Response.json({});
			},
		});
		const target: ApiTarget = { url: server.url.origin, token: "node-token" };
		try {
			for (const operation of operations) {
				for (const [id, segment] of [
					// Hostile IDs: the whole value becomes one encoded segment.
					[
						"../apps/@ryu%2Fbrowser/disable#",
						"..%2Fapps%2F%40ryu%252Fbrowser%2Fdisable%23",
					],
					["../../pair/clients/c1?", "..%2F..%2Fpair%2Fclients%2Fc1%3F"],
					["%2e%2e", "%252e%252e"],
					// A normal ID reaches Core byte-for-byte as before.
					["mon_0123abcd", "mon_0123abcd"],
				] as const) {
					requests.length = 0;
					const error = await rejection(() => operation.call(target, id));
					expect(String(error)).not.toContain("dot segment");
					expect({ operation: operation.name, requests }).toEqual({
						operation: operation.name,
						requests: [
							{
								method: operation.method,
								pathname: operation.path(segment),
								search: operation.search ?? "",
							},
						],
					});
				}
			}
		} finally {
			await server.stop(true);
		}
	});

	test("bare dot segments are refused before any request", async () => {
		const requests: string[] = [];
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				requests.push(new URL(request.url).pathname);
				return Response.json({});
			},
		});
		const target: ApiTarget = { url: server.url.origin, token: "node-token" };
		try {
			for (const operation of operations) {
				for (const id of [".", ".."]) {
					const error = await rejection(() => operation.call(target, id));
					expect({ operation: operation.name, error: String(error) }).toEqual({
						operation: operation.name,
						error: "Error: ID cannot be a URL dot segment",
					});
				}
			}
			expect(requests).toEqual([]);
		} finally {
			await server.stop(true);
		}
	});

	test("a dot-segment quest ID is refused by the judge verb before any request", async () => {
		const requests: string[] = [];
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				requests.push(new URL(request.url).pathname);
				return Response.json({});
			},
		});
		const target: ApiTarget = { url: server.url.origin, token: "node-token" };
		try {
			for (const id of [".", ".."]) {
				const error = await rejection(() => judgeQuest(target, id));
				expect(String(error)).toBe("Error: ID cannot be a URL dot segment");
			}
			expect(requests).toEqual([]);
		} finally {
			await server.stop(true);
		}
	});
});
