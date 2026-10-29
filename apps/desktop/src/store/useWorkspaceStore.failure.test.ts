import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
const { emptyEnvironmentScripts, useWorkspaceStore } = await import(
	"./useWorkspaceStore.ts"
);
const keys = {
	projects: "ryu_workspace_projects_v1",
	recents: "ryu_workspace_recents",
	removed: "ryu_workspace_removed",
	folder: "ryu_workspace_folder",
	names: "ryu_workspace_names",
	icons: "ryu_workspace_icons",
	environments: "ryu_workspace_environments_v1",
	active: "ryu_workspace_active_environments_v1",
};
const environment = {
	id: "old",
	name: "Old",
	setup: emptyEnvironmentScripts(),
	cleanup: emptyEnvironmentScripts(),
	variables: [],
	actions: [],
};
let restore: (() => void) | null = null;
function stored() {
	return Object.fromEntries(
		Array.from(
			{ length: localStorage.length },
			(_, index) => localStorage.key(index)!
		)
			.sort()
			.map((key) => [key, localStorage.getItem(key)])
	);
}
beforeEach(() => {
	localStorage.clear();
	const projects = [
		{ id: "project", folders: ["/project"] },
		{ id: "other", folders: ["/other"] },
	];
	const projectNames = { "/project": "Original", "/other": "Other" };
	const projectIcons = {
		"/project": { kind: "emoji" as const, emoji: "A" },
		"/other": { kind: "emoji" as const, emoji: "B" },
	};
	const projectEnvironments = {
		"/project": [environment],
		"/other": [environment],
	};
	const activeProjectEnvironments = { "/project": "old", "/other": "old" };
	const rows = {
		[keys.projects]: JSON.stringify(projects),
		[keys.recents]: '["/project","/other",{"futureFolder":"retained"}]',
		[keys.removed]: '["/removed"]',
		[keys.folder]: "/project",
		[keys.names]: JSON.stringify(projectNames),
		[keys.icons]: JSON.stringify(projectIcons),
		[keys.environments]: JSON.stringify(projectEnvironments),
		[keys.active]: JSON.stringify(activeProjectEnvironments),
		unrelated: '{"preserve":[1,2,3]}',
		ryu_workspace_worktree_branch: "ryu/retained",
	};
	for (const [key, value] of Object.entries(rows)) {
		localStorage.setItem(key, value);
	}
	useWorkspaceStore.setState({
		projects,
		recentFolders: ["/project", "/other"],
		removedProjects: ["/removed"],
		folder: "/project",
		projectNames,
		projectIcons,
		projectEnvironments,
		activeProjectEnvironments,
		worktreeBranch: "ryu/retained",
	});
});
afterEach(() => {
	restore?.();
	restore = null;
});
function intercept(
	write: (key: string, value: string, original: Storage["setItem"]) => void
) {
	const original = localStorage.setItem;
	Object.defineProperty(localStorage, "setItem", {
		configurable: true,
		value: (key: string, value: string) => write(key, value, original),
	});
	restore = () =>
		Object.defineProperty(localStorage, "setItem", {
			configurable: true,
			value: original,
		});
}

for (const operation of [
	"add",
	"rename",
	"environment",
	"remove",
	"folders",
	"remove-recent",
] as const) {
	test(`${operation} rolls back prior durable writes on refusal and retries without changing another project`, async () => {
		const beforeBytes = stored();
		const beforeState = useWorkspaceStore.getState();
		const target =
			operation === "add" || operation === "folders"
				? keys.recents
				: operation === "rename"
					? keys.names
					: operation === "environment"
						? keys.active
						: keys.icons;
		let refusals = 0;
		intercept((key, value, original) => {
			if (key === target) {
				refusals += 1;
				throw new DOMException("Workspace write refused", "QuotaExceededError");
			}
			original(key, value);
		});
		if (operation === "remove-recent") {
			const originalRemove = localStorage.removeItem;
			const restoreSet = restore;
			Object.defineProperty(localStorage, "removeItem", {
				configurable: true,
				value: (key: string) => {
					if (key === keys.folder) {
						refusals += 1;
						throw new DOMException("Workspace write refused", "SecurityError");
					}
					originalRemove(key);
				},
			});
			restore = () => {
				restoreSet?.();
				Object.defineProperty(localStorage, "removeItem", {
					configurable: true,
					value: originalRemove,
				});
			};
		}
		const mutate = () => {
			const state = useWorkspaceStore.getState();
			if (operation === "add") {
				state.addProjectFolder("/new");
			}
			if (operation === "rename") {
				state.setProjectName("/project", "Renamed");
			}
			if (operation === "environment") {
				state.setProjectEnvironments(
					"/project",
					[{ ...environment, id: "new", name: "New" }],
					"new"
				);
			}
			if (operation === "remove") {
				state.removeProject("/project");
			}
			if (operation === "folders") {
				state.setProjectFolders("project", ["/new-root"]);
			}
			if (operation === "remove-recent") {
				state.removeRecentFolder("/project");
			}
		};
		expect(mutate).toThrow("Workspace write refused");
		expect(refusals).toBe(1);
		expect(useWorkspaceStore.getState()).toBe(beforeState);
		expect(stored()).toEqual(beforeBytes);
		restore?.();
		restore = null;
		const independent = await import(
			`./useWorkspaceStore.ts?refusal-${operation}-${Date.now()}`
		);
		expect(independent.useWorkspaceStore.getState().projects).toEqual(
			beforeState.projects
		);
		expect(independent.useWorkspaceStore.getState().folder).toBe(
			beforeState.folder
		);
		expect(
			independent.useWorkspaceStore.getState().projectEnvironments
		).toEqual(beforeState.projectEnvironments);
		mutate();
		const after = useWorkspaceStore.getState();
		expect(after.projects.find((project) => project.id === "other")).toEqual(
			beforeState.projects.find((project) => project.id === "other")
		);
		expect(after.projectNames["/other"]).toBe("Other");
		expect(after.projectIcons["/other"]).toEqual(
			beforeState.projectIcons["/other"]
		);
		expect(after.projectEnvironments["/other"]).toEqual(
			beforeState.projectEnvironments["/other"]
		);
		expect(after.activeProjectEnvironments["/other"]).toBe("old");
		expect(localStorage.getItem("unrelated")).toBe(beforeBytes.unrelated);
		if (operation === "add") {
			expect(after.recentFolders).toEqual(["/new", "/project", "/other"]);
		}
		if (operation === "rename") {
			expect(after.projectNames["/project"]).toBe("Renamed");
		}
		if (operation === "environment") {
			expect(after.activeProjectEnvironments["/project"]).toBe("new");
		}
		if (operation === "remove") {
			expect(after.projects).toEqual([beforeState.projects[1]]);
		}
		if (operation === "folders") {
			expect(after.folder).toBe("/new-root");
			expect(after.projects[0]?.folders).toEqual(["/new-root"]);
		}
		if (operation === "remove-recent") {
			expect(after.folder).toBeNull();
			expect(after.recentFolders).toEqual(["/other"]);
		}
		const reloaded = await import(
			`./useWorkspaceStore.ts?retry-${operation}-${Date.now()}`
		);
		expect(reloaded.useWorkspaceStore.getState().projects).toEqual(
			after.projects
		);
		expect(reloaded.useWorkspaceStore.getState().recentFolders).toEqual(
			after.recentFolders
		);
		expect(reloaded.useWorkspaceStore.getState().projectNames).toEqual(
			after.projectNames
		);
		expect(reloaded.useWorkspaceStore.getState().projectEnvironments).toEqual(
			after.projectEnvironments
		);
		expect(
			reloaded.useWorkspaceStore.getState().activeProjectEnvironments
		).toEqual(after.activeProjectEnvironments);
		expect(reloaded.useWorkspaceStore.getState().projectIcons).toEqual(
			after.projectIcons
		);
		expect(reloaded.useWorkspaceStore.getState().removedProjects).toEqual(
			after.removedProjects
		);
		expect(reloaded.useWorkspaceStore.getState().folder).toBe(after.folder);
		expect(
			JSON.parse(localStorage.getItem(keys.recents) ?? "null")
		).toContainEqual({ futureFolder: "retained" });
	});
}

test("a refused rollback preserves the primary error and explicitly reports incomplete recovery", () => {
	const beforeState = useWorkspaceStore.getState();
	const before = stored();
	const primary = new DOMException(
		"Initial recents refusal",
		"QuotaExceededError"
	);
	const rollback = new DOMException("Rollback refusal", "SecurityError");
	let failed = false;
	intercept((key, value, original) => {
		if (key === keys.recents) {
			failed = true;
			throw primary;
		}
		if (failed && key === keys.projects) {
			throw rollback;
		}
		original(key, value);
	});
	let failure: unknown;
	try {
		beforeState.addProjectFolder("/new");
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(AggregateError);
	if (!(failure instanceof AggregateError)) {
		throw new Error("Expected an explicit incomplete rollback error");
	}
	expect(failure.cause).toBe(primary);
	expect(failure.errors).toEqual([primary, rollback]);
	expect(useWorkspaceStore.getState()).toBe(beforeState);
	expect(localStorage.getItem(keys.projects)).not.toBe(before[keys.projects]);
	expect(localStorage.getItem(keys.recents)).toBe(before[keys.recents]);
	expect(localStorage.getItem("unrelated")).toBe(before.unrelated);
	restore?.();
	restore = null;
	beforeState.addProjectFolder("/new");
	expect(useWorkspaceStore.getState().recentFolders).toEqual([
		"/new",
		"/project",
		"/other",
	]);
});

test("a refused legacy-project registration removes newly created keys during rollback", async () => {
	localStorage.removeItem(keys.projects);
	const legacy = await import(`./useWorkspaceStore.ts?legacy-${Date.now()}`);
	useWorkspaceStore.setState({
		projects: legacy.useWorkspaceStore.getState().projects,
	});
	const before = stored();
	const beforeState = useWorkspaceStore.getState();
	intercept((key, value, original) => {
		if (key === keys.recents) {
			throw new DOMException("Workspace write refused", "QuotaExceededError");
		}
		original(key, value);
	});
	expect(() => beforeState.addProjectFolder("/new")).toThrow(
		"Workspace write refused"
	);
	expect(stored()).toEqual(before);
	expect(localStorage.getItem(keys.projects)).toBeNull();
	expect(useWorkspaceStore.getState()).toBe(beforeState);
	restore?.();
	restore = null;
	const independent = await import(
		`./useWorkspaceStore.ts?legacy-rollback-${Date.now()}`
	);
	expect(independent.useWorkspaceStore.getState().projects).toEqual(
		beforeState.projects
	);
	beforeState.addProjectFolder("/new");
	expect(useWorkspaceStore.getState().recentFolders).toEqual([
		"/new",
		"/project",
		"/other",
	]);
	expect(JSON.parse(localStorage.getItem(keys.projects) ?? "null")).toEqual(
		useWorkspaceStore.getState().projects
	);
});

test("rollback conserves unrelated workspace records changed by another storage writer", () => {
	const before = useWorkspaceStore.getState();
	const originalProjects = localStorage.getItem(keys.projects);
	const externalNames = '{"/other":"Externally renamed"}';
	const externalPreference = "external-branch";
	intercept((key, value, original) => {
		if (key === keys.recents) {
			original(keys.names, externalNames);
			original("ryu_workspace_worktree_branch", externalPreference);
			throw new DOMException("Workspace write refused", "QuotaExceededError");
		}
		original(key, value);
	});
	expect(() => before.addProjectFolder("/new")).toThrow(
		"Workspace write refused"
	);
	expect(useWorkspaceStore.getState()).toBe(before);
	expect(localStorage.getItem(keys.projects)).toBe(originalProjects);
	expect(localStorage.getItem(keys.names)).toBe(externalNames);
	expect(localStorage.getItem("ryu_workspace_worktree_branch")).toBe(
		externalPreference
	);
});
