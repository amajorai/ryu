import { describe, expect, test } from "bun:test";
import type { ProjectRecord } from "@/src/lib/api/hierarchy.ts";
import type { Conversation } from "@/types/chat.ts";
import {
	folderProjectMapKey,
	parseFolderProjectMap,
	planFolderProjectMigration,
	threadsToPlace,
} from "./folder-project-migration.ts";

const atlas = { folders: ["/work/atlas", "/work/atlas-api"], id: "ws-atlas" };
const notes = { folders: ["/work/notes"], id: "ws-notes", name: "Notes" };
const nodeProject = (id: string, cwd?: string): ProjectRecord => ({
	cwd,
	description: "",
	id,
	name: id,
	status: "planned",
});

function conv(
	id: string,
	folderPath?: string,
	projectId?: string
): Conversation {
	return {
		createdAt: 1,
		folderPath,
		hierarchy: projectId ? { projectId, role: "session" } : undefined,
		id,
		messages: [],
		title: id,
		updatedAt: 1,
	};
}

describe("folder project migration", () => {
	test("creates node projects for unmapped folder projects", () => {
		const steps = planFolderProjectMigration({
			map: {},
			nodeProjects: [],
			workspaceProjects: [atlas, notes],
		});
		expect(steps.map((step) => step.kind)).toEqual(["create", "create"]);
		expect(steps[0]).toMatchObject({
			name: "atlas",
			primaryFolder: "/work/atlas",
		});
		expect(steps[1]).toMatchObject({ name: "Notes" });
	});

	test("adopts a node project that already covers the folder (no duplicates)", () => {
		const steps = planFolderProjectMigration({
			map: {},
			nodeProjects: [nodeProject("project_1", "/work/atlas/")],
			workspaceProjects: [atlas],
		});
		expect(steps).toEqual([
			{ kind: "adopt", projectId: "project_1", workspaceProject: atlas },
		]);
	});

	test("skips mapped, removed, and folderless projects; re-plans a mapping whose project is gone", () => {
		expect(
			planFolderProjectMigration({
				map: { "ws-atlas": "project_1" },
				nodeProjects: [nodeProject("project_1")],
				removedFolders: ["/work/notes"],
				workspaceProjects: [atlas, notes, { folders: [], id: "empty" }],
			})
		).toEqual([]);
		expect(
			planFolderProjectMigration({
				map: { "ws-atlas": "deleted" },
				nodeProjects: [],
				workspaceProjects: [atlas],
			}).length
		).toBe(1);
	});

	test("places folder threads under the project main thread, never moving placed ones", () => {
		const main: Conversation = {
			...conv("main"),
			hierarchy: {
				ownerId: "project_1",
				ownerKind: "project",
				projectId: "project_1",
				role: "main",
			},
		};
		const placements = threadsToPlace(
			[
				main,
				conv("a", "/work/atlas"),
				conv("b", "/work/atlas-api"),
				conv("c", "/work/atlas", "other"),
				conv("d", "/elsewhere"),
				conv("e"),
			],
			{ "ws-atlas": "project_1" },
			[atlas]
		);
		expect(placements).toEqual([
			{ conversationId: "a", mainThreadId: "main", projectId: "project_1" },
			{ conversationId: "b", mainThreadId: "main", projectId: "project_1" },
		]);
	});

	test("placement waits until the project's main thread is loaded", () => {
		expect(
			threadsToPlace([conv("a", "/work/atlas")], { "ws-atlas": "project_1" }, [
				atlas,
			])
		).toEqual([]);
	});

	test("the mapping is per node and tolerant of junk", () => {
		expect(folderProjectMapKey("http://127.0.0.1:7980/")).toBe(
			"ryu:folder-project-map:v1:http://127.0.0.1:7980"
		);
		expect(parseFolderProjectMap('{"ws":"p","bad":1}')).toEqual({ ws: "p" });
		expect(parseFolderProjectMap("not json")).toEqual({});
		expect(parseFolderProjectMap("[]")).toEqual({});
	});
});
