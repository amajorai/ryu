import { afterAll, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
const recentsKey = "ryu_workspace_recents";
const removedKey = "ryu_workspace_removed";
const iconsKey = "ryu_workspace_icons";
const namesKey = "ryu_workspace_names";
const environmentsKey = "ryu_workspace_environments_v1";
const rawRecents =
	'["/project",null,{"futureFolder":"/future","__proto__":{"retained":true}}]';
const rawRemoved = '["/removed",7,{"futureFolder":"/removed-future"}]';
const rawIcons =
	'{"/project":{"kind":"dicebear","style":"future-style","seed":"long-seed"},"/legacy":{"type":"emoji","value":""},"/bad":{"kind":"future"}}';
const rawNames = '{"/project":"  Project  ","/bad":7}';
const rawEnvironments =
	'{"/project":[{"id":"env","name":" Environment ","setup":{"default":"echo ready","macos":"","linux":"","windows":"","future":{"retained":true}},"cleanup":{"default":"","macos":"","linux":"","windows":""},"variables":[{"id":"v","key":"TOKEN","value":"","future":true},null],"actions":[]}]}';
localStorage.setItem(recentsKey, rawRecents);
localStorage.setItem(removedKey, rawRemoved);
localStorage.setItem(iconsKey, rawIcons);
localStorage.setItem(namesKey, rawNames);
localStorage.setItem(environmentsKey, rawEnvironments);
const { useWorkspaceStore } = await import("./useWorkspaceStore.ts");
afterAll(() => GlobalRegistrator.unregister());

it("hydrates the real workspace store without rewriting legacy preference bytes", () => {
	const state = useWorkspaceStore.getState();
	expect(state.recentFolders).toEqual(["/project"]);
	expect(state.removedProjects).toEqual(["/removed"]);
	expect(state.projectIcons).toEqual({
		"/project": { kind: "dicebear", style: "future-style", seed: "long-seed" },
		"/legacy": { kind: "emoji", emoji: "" },
	});
	expect(state.projectNames).toEqual({ "/project": "Project" });
	expect(state.projectEnvironments["/project"]?.[0]?.name).toBe("Environment");
	const expectedVariable = { id: "v", key: "TOKEN", value: "", future: true };
	expect(state.projectEnvironments["/project"]?.[0]?.variables).toEqual([
		expectedVariable,
	]);
	expect(localStorage.getItem(recentsKey)).toBe(rawRecents);
	expect(localStorage.getItem(removedKey)).toBe(rawRemoved);
	expect(localStorage.getItem(iconsKey)).toBe(rawIcons);
	expect(localStorage.getItem(namesKey)).toBe(rawNames);
	expect(localStorage.getItem(environmentsKey)).toBe(rawEnvironments);
});
it("adds and removes real project paths while retaining unsupported future stored rows", () => {
	useWorkspaceStore.getState().addProjectFolder("/new");
	expect(useWorkspaceStore.getState().recentFolders).toEqual([
		"/new",
		"/project",
	]);
	expect(localStorage.getItem(recentsKey)).toBe(
		'["/new","/project",null,{"futureFolder":"/future","__proto__":{"retained":true}}]'
	);
	useWorkspaceStore.getState().removeProject("/project");
	expect(useWorkspaceStore.getState().recentFolders).toEqual(["/new"]);
	expect(localStorage.getItem(recentsKey)).toBe(
		'["/new",null,{"futureFolder":"/future","__proto__":{"retained":true}}]'
	);
	expect(useWorkspaceStore.getState().removedProjects).toContain("/project");
	expect(localStorage.getItem(removedKey)).toBe(
		'["/removed","/project",7,{"futureFolder":"/removed-future"}]'
	);
});

it("bounds recent paths without erasing unrelated future rows at capacity", () => {
	const paths = Array.from({ length: 10 }, (_, index) => `/capacity-${index}`);
	const futureRows = [null, { futureFolder: "/future", version: 2 }, 7];
	localStorage.setItem(recentsKey, JSON.stringify([...paths, ...futureRows]));
	useWorkspaceStore.setState({ recentFolders: paths });
	useWorkspaceStore.getState().addProjectFolder("/capacity-new");
	const expectedPaths = ["/capacity-new", ...paths.slice(0, 9)];
	expect(useWorkspaceStore.getState().recentFolders).toEqual(expectedPaths);
	expect(JSON.parse(localStorage.getItem(recentsKey) ?? "null")).toEqual([
		...expectedPaths,
		...futureRows,
	]);
	// A subsequent removal must retain the same unknown records too.
	useWorkspaceStore.getState().removeRecentFolder("/capacity-0");
	expect(JSON.parse(localStorage.getItem(recentsKey) ?? "null")).toEqual([
		...expectedPaths.filter((path) => path !== "/capacity-0"),
		...futureRows,
	]);
});

it("rehydrates from another window's write so the next save keeps its projects", () => {
	const projectsKey = "ryu_workspace_projects_v1";
	const otherWindowProjects = [
		...useWorkspaceStore.getState().projects,
		{ folders: ["/from-other-window"], id: "other-window" },
	];
	localStorage.setItem(projectsKey, JSON.stringify(otherWindowProjects));
	localStorage.setItem(
		recentsKey,
		JSON.stringify([
			"/from-other-window",
			...useWorkspaceStore.getState().recentFolders,
		])
	);
	window.dispatchEvent(new StorageEvent("storage", { key: projectsKey }));
	const synced = useWorkspaceStore.getState();
	expect(
		synced.projects.some((project) =>
			project.folders.includes("/from-other-window")
		)
	).toBe(true);
	expect(synced.recentFolders[0]).toBe("/from-other-window");

	useWorkspaceStore.getState().addProjectFolder("/this-window");
	const storedFolders = (
		JSON.parse(localStorage.getItem(projectsKey) ?? "[]") as {
			folders: string[];
		}[]
	).flatMap((project) => project.folders);
	expect(storedFolders).toContain("/from-other-window");
	expect(storedFolders).toContain("/this-window");

	const before = useWorkspaceStore.getState().projects;
	window.dispatchEvent(
		new StorageEvent("storage", { key: "ryu_workspace_terminal_shell" })
	);
	expect(useWorkspaceStore.getState().projects).toBe(before);
});
