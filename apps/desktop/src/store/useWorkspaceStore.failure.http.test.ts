import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeRequest = globalThis.Request;
const NativeHeaders = globalThis.Headers;
const requests: {
	path: string;
	bearer: string | null;
	delegation: string | null;
}[] = [];
const posts: {
	url: string;
	bearer: string | null;
	delegation: string | null;
	body: unknown;
}[] = [];
let postRelease: (() => void) | null = null;
let postAcknowledgement: Promise<void> | null = null;
let completedPosts = 0;
async function postResponse(request: Request, alternate: boolean) {
	const target = new URL(request.url);
	if (
		request.method !== "POST" ||
		!["/api/workspace/new-folder", "/api/workspace/clone"].includes(
			target.pathname
		)
	) {
		return NativeResponse.json(
			{ error: "Unexpected mutation" },
			{ status: 404 }
		);
	}
	const bearer = request.headers.get("authorization");
	const delegation = request.headers.get("x-ryu-user-jwt");
	posts.push({
		url: request.url,
		bearer,
		delegation,
		body: await request.json(),
	});
	const valid = alternate
		? bearer === "Bearer alternate-token" &&
			delegation === "alternate-delegation"
		: bearer === "Bearer workspace-fixture-token" &&
			["workspace-fixture-delegation", "rotated-delegation"].includes(
				delegation ?? ""
			);
	if (!valid) {
		return NativeResponse.json({ error: "Credential denied" }, { status: 401 });
	}
	if (postAcknowledgement && !alternate) {
		await postAcknowledgement;
	}
	completedPosts++;
	return NativeResponse.json({
		path: alternate ? "/newer" : "/new",
		name: "created",
	});
}
const alternateServer = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: (request) => postResponse(request, true),
});
let browseListing = false;
let status = 200;
let release: (() => void) | null = null;
let acknowledge: Promise<void> | null = null;
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const responseStatus = status;
		if (request.method === "POST") {
			return postResponse(request, false);
		}
		requests.push({
			path: url.pathname + url.search,
			bearer: request.headers.get("authorization"),
			delegation: request.headers.get("x-ryu-user-jwt"),
		});
		if (
			browseListing &&
			url.pathname === "/api/workspace/list" &&
			url.searchParams.get("path") === "::this-pc" &&
			request.headers.get("authorization") ===
				"Bearer workspace-fixture-token" &&
			request.headers.get("x-ryu-user-jwt") === "workspace-fixture-delegation"
		) {
			return NativeResponse.json({
				path: "::this-pc",
				home: "/home",
				parent: null,
				entries: [{ name: "New fixture", path: "/new" }],
			});
		}
		if (
			url.pathname !== "/api/workspace/list" ||
			!["/new", "/newer"].includes(url.searchParams.get("path") ?? "") ||
			request.headers.get("authorization") !==
				"Bearer workspace-fixture-token" ||
			!["workspace-fixture-delegation", "rotated-delegation"].includes(
				request.headers.get("x-ryu-user-jwt") ?? ""
			)
		) {
			return NativeResponse.json(
				{ error: "Unexpected request" },
				{ status: 401 }
			);
		}
		if (acknowledge && url.searchParams.get("path") === "/new") {
			await acknowledge;
		}
		return responseStatus === 200
			? NativeResponse.json({
					path: url.searchParams.get("path"),
					home: "/home",
					parent: null,
					entries: [],
				})
			: NativeResponse.json(
					{ error: "Directory denied" },
					{ status: responseStatus }
				);
	},
});
const previousCoreUrl = process.env.VITE_CORE_URL;
process.env.VITE_CORE_URL = server.url.origin;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
globalThis.fetch = nativeFetch;
globalThis.Response = NativeResponse;
globalThis.Request = NativeRequest;
globalThis.Headers = NativeHeaders;
const { useWorkspaceStore } = await import("./useWorkspaceStore.ts");
const { LOCAL_FALLBACK, useNodeStore } = await import("./useNodeStore.ts");
const folderKey = "ryu_workspace_folder";
const projectsKey = "ryu_workspace_projects_v1";
const recentsKey = "ryu_workspace_recents";
let restore: (() => void) | null = null;
let pendingSelection: Promise<unknown> | null = null;
function bytes() {
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
	requests.length = 0;
	browseListing = false;
	posts.length = 0;
	completedPosts = 0;
	postAcknowledgement = null;
	status = 200;
	acknowledge = null;
	localStorage.clear();
	const projects = [{ id: "existing", folders: ["/existing"] }];
	localStorage.setItem(folderKey, "/existing");
	localStorage.setItem(projectsKey, JSON.stringify(projects));
	localStorage.setItem(recentsKey, '["/existing",{"futureFolder":"retained"}]');
	localStorage.setItem("ryu_workspace_worktree_branch", "ryu/retained");
	localStorage.setItem("ryu_client_id", "workspace-fixture-client");
	localStorage.setItem("unrelated", '{"keep":true}');
	useWorkspaceStore.setState({
		projects,
		folder: "/existing",
		recentFolders: ["/existing"],
		removedProjects: [],
		projectNames: {},
		projectIcons: {},
		projectEnvironments: {},
		activeProjectEnvironments: {},
		worktreeBranch: "ryu/retained",
	});
	useNodeStore.setState({
		nodes: [
			{
				...LOCAL_FALLBACK,
				token: "workspace-fixture-token",
				userJwt: "workspace-fixture-delegation",
			},
		],
		defaultNode: LOCAL_FALLBACK.name,
		autoSelect: false,
		autoSelectedNode: null,
		tabOverrides: {},
	});
});
afterEach(async () => {
	release?.();
	postRelease?.();
	postRelease = null;
	postAcknowledgement = null;
	release = null;
	await pendingSelection;
	pendingSelection = null;
	acknowledge = null;
	restore?.();
	restore = null;
});
afterAll(() => {
	server.stop(true);
	alternateServer.stop(true);
	if (previousCoreUrl === undefined) {
		delete process.env.VITE_CORE_URL;
	} else {
		process.env.VITE_CORE_URL = previousCoreUrl;
	}
});

test("Core directory refusal preserves every stored record and the selected project", async () => {
	status = 403;
	const before = bytes();
	const state = useWorkspaceStore.getState();
	await expect(state.setFolder("/new")).rejects.toThrow("Directory denied");
	expect(requests).toEqual([
		{
			path: "/api/workspace/list?path=%2Fnew",
			bearer: "Bearer workspace-fixture-token",
			delegation: "workspace-fixture-delegation",
		},
	]);
	expect(useWorkspaceStore.getState()).toBe(state);
	expect(bytes()).toEqual(before);
});

test("selection waits for actual Core acknowledgement then rolls back refused writes and retries", async () => {
	const before = bytes();
	const state = useWorkspaceStore.getState();
	acknowledge = new Promise<void>((resolve) => {
		release = resolve;
	});
	const original = localStorage.setItem;
	Object.defineProperty(localStorage, "setItem", {
		configurable: true,
		value: (key: string, value: string) => {
			if (key === recentsKey) {
				throw new DOMException("Recents refused", "QuotaExceededError");
			}
			original(key, value);
		},
	});
	restore = () =>
		Object.defineProperty(localStorage, "setItem", {
			configurable: true,
			value: original,
		});
	const pending = state.setFolder("/new").then(
		(acknowledged) => acknowledged,
		(error) => error
	);
	pendingSelection = pending;
	for (let attempt = 0; requests.length === 0 && attempt < 100; attempt++) {
		await Bun.sleep(5);
	}
	expect(requests).toHaveLength(1);
	expect(useWorkspaceStore.getState()).toBe(state);
	expect(bytes()).toEqual(before);
	release?.();
	release = null;
	const refusal = await pending;
	expect(refusal).toBeInstanceOf(DOMException);
	expect(refusal.message).toBe("Recents refused");
	expect(useWorkspaceStore.getState()).toBe(state);
	expect(bytes()).toEqual(before);
	restore?.();
	restore = null;
	acknowledge = null;
	await state.setFolder("/new");
	expect(requests).toHaveLength(2);
	const after = useWorkspaceStore.getState();
	expect(after.folder).toBe("/new");
	expect(after.projects[0]).toEqual(state.projects[0]);
	expect(after.projects[1]?.folders).toEqual(["/new"]);
	expect(after.recentFolders).toEqual(["/new", "/existing"]);
	expect(localStorage.getItem("unrelated")).toBe(before.unrelated);
	expect(JSON.parse(localStorage.getItem(recentsKey) ?? "null")).toContainEqual(
		{ futureFolder: "retained" }
	);
	const reloaded = await import(
		`./useWorkspaceStore.ts?acknowledged-http-${Date.now()}`
	);
	expect(reloaded.useWorkspaceStore.getState().folder).toBe(after.folder);
	expect(reloaded.useWorkspaceStore.getState().projects).toEqual(
		after.projects
	);
	expect(reloaded.useWorkspaceStore.getState().recentFolders).toEqual(
		after.recentFolders
	);
});

test("a directory acknowledgement from an old node cannot publish after an A-B-A switch", async () => {
	const state = useWorkspaceStore.getState();
	const before = bytes();
	acknowledge = new Promise<void>((resolve) => {
		release = resolve;
	});
	const pending = state.setFolder("/new").then(
		(acknowledged) => acknowledged,
		(error) => error
	);
	pendingSelection = pending;
	for (let attempt = 0; requests.length === 0 && attempt < 100; attempt++) {
		await Bun.sleep(5);
	}
	expect(requests).toHaveLength(1);
	const originalNodes = useNodeStore.getState().nodes;
	useNodeStore.setState({
		nodes: [
			...originalNodes,
			{
				name: "alternate",
				url: `${server.url.origin}/alternate`,
				token: "alternate-token",
				userJwt: "alternate-delegation",
			},
		],
		defaultNode: "alternate",
	});
	useNodeStore.setState({ defaultNode: LOCAL_FALLBACK.name });
	release?.();
	release = null;
	expect(await pending).toBe(false);
	expect(useWorkspaceStore.getState()).toBe(state);
	expect(bytes()).toEqual(before);
	expect(requests[0]?.bearer).toBe("Bearer workspace-fixture-token");
	expect(requests[0]?.delegation).toBe("workspace-fixture-delegation");
});

test("clear selection invalidates an outstanding directory acknowledgement", async () => {
	acknowledge = new Promise<void>((resolve) => {
		release = resolve;
	});
	const pending = useWorkspaceStore
		.getState()
		.setFolder("/new")
		.then(
			(acknowledged) => acknowledged,
			(error) => error
		);
	pendingSelection = pending;
	for (let attempt = 0; requests.length === 0 && attempt < 100; attempt++) {
		await Bun.sleep(5);
	}
	expect(requests).toHaveLength(1);
	useWorkspaceStore.getState().clearFolder();
	const cleared = useWorkspaceStore.getState();
	const before = bytes();
	release?.();
	release = null;
	expect(await pending).toBe(false);
	expect(useWorkspaceStore.getState()).toBe(cleared);
	expect(useWorkspaceStore.getState().folder).toBeNull();
	expect(bytes()).toEqual(before);
});

test("a newer same-node selection wins over a late acknowledged directory read", async () => {
	acknowledge = new Promise<void>((resolve) => {
		release = resolve;
	});
	const pending = useWorkspaceStore
		.getState()
		.setFolder("/new")
		.then(
			(acknowledged) => acknowledged,
			(error) => error
		);
	pendingSelection = pending;
	for (let attempt = 0; requests.length === 0 && attempt < 100; attempt++) {
		await Bun.sleep(5);
	}
	expect(requests).toHaveLength(1);
	await useWorkspaceStore.getState().setFolder("/newer");
	const selected = useWorkspaceStore.getState();
	const before = bytes();
	expect(selected.folder).toBe("/newer");
	release?.();
	release = null;
	expect(await pending).toBe(false);
	expect(useWorkspaceStore.getState()).toBe(selected);
	expect(bytes()).toEqual(before);
	expect(
		selected.projects.some((project) => project.folders.includes("/new"))
	).toBe(false);
	expect(requests.map((request) => request.path)).toEqual([
		"/api/workspace/list?path=%2Fnew",
		"/api/workspace/list?path=%2Fnewer",
	]);
});

test("the directory-selection node subscription is released on success, failure and supersession", async () => {
	const originalSubscribe = useNodeStore.subscribe;
	let active = 0;
	let subscribed = 0;
	let disposed = 0;
	useNodeStore.subscribe = (listener) => {
		const unsubscribe = originalSubscribe(listener);
		active++;
		subscribed++;
		let closed = false;
		return () => {
			expect(closed).toBe(false);
			closed = true;
			active--;
			disposed++;
			unsubscribe();
		};
	};
	try {
		await useWorkspaceStore.getState().setFolder("/new");
		expect(active).toBe(0);
		status = 403;
		await expect(
			useWorkspaceStore.getState().setFolder("/new")
		).rejects.toThrow("Directory denied");
		expect(active).toBe(0);
		status = 200;
		requests.length = 0;
		acknowledge = new Promise<void>((resolve) => {
			release = resolve;
		});
		const pending = useWorkspaceStore
			.getState()
			.setFolder("/new")
			.then(
				(acknowledged) => acknowledged,
				(error) => error
			);
		pendingSelection = pending;
		for (let attempt = 0; requests.length === 0 && attempt < 100; attempt++) {
			await Bun.sleep(5);
		}
		expect(requests).toHaveLength(1);
		expect(active).toBe(1);
		useWorkspaceStore.getState().clearFolder();
		release?.();
		release = null;
		expect(await pending).toBe(false);
		expect(active).toBe(0);
		expect(subscribed).toBe(3);
		expect(disposed).toBe(3);
	} finally {
		release?.();
		await pendingSelection;
		useNodeStore.subscribe = originalSubscribe;
	}
});

test("the mounted project picker reports only acknowledged selection and retains failed or cancelled intent", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const { act, createElement } = await import("react");
	const { createRoot } = await import("react-dom/client");
	const { ProjectCommandDialog } = await import(
		"../components/chat/ProjectPicker.tsx"
	);
	useWorkspaceStore.getState().addProjectFolder("/new");
	const selected: string[] = [];
	let closes = 0;
	let outstanding = 0;
	const subscribe = useNodeStore.subscribe;
	useNodeStore.subscribe = (listener) => {
		const unsubscribe = subscribe(listener);
		outstanding++;
		return () => {
			outstanding--;
			unsubscribe();
		};
	};
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	async function settle(predicate: () => boolean) {
		for (let attempt = 0; !predicate() && attempt < 100; attempt++) {
			await act(async () => {
				await Bun.sleep(5);
			});
		}
		expect(predicate()).toBe(true);
	}
	// The project picker is a command dialog: each project is an option row,
	// and keyboard focus lives in its search field.
	const openButton = () =>
		document.querySelector<HTMLElement>(
			'[role="option"][aria-label="Open new"]'
		);
	const searchFieldFocused = () =>
		document.activeElement !== null &&
		document.activeElement ===
			document.querySelector('input[placeholder="Search projects"]');
	try {
		await act(async () =>
			root.render(
				createElement(ProjectCommandDialog, {
					onFolderSelected: (folder: string) => {
						selected.push(folder);
					},
					onOpenChange: (open: boolean) => {
						if (!open) {
							closes++;
						}
					},
					open: true,
				})
			)
		);
		expect(openButton()).not.toBeNull();
		await settle(searchFieldFocused);
		acknowledge = new Promise<void>((resolve) => {
			release = resolve;
		});
		await act(async () => {
			openButton()!.click();
		});
		await settle(() => requests.length === 1);
		// One dialog operation fence and one directory-read fence are pending.
		expect(outstanding).toBe(2);
		await act(async () => {
			useWorkspaceStore.getState().clearFolder();
			release?.();
			release = null;
		});
		await settle(() => outstanding === 0);
		expect(selected).toEqual([]);
		expect(closes).toBe(0);
		expect(useWorkspaceStore.getState().folder).toBeNull();
		expect(openButton()).not.toBeNull();
		// A cancelled selection leaves the picker, and keyboard focus, where they were.
		expect(searchFieldFocused()).toBe(true);
		acknowledge = null;
		status = 403;
		await act(async () => {
			openButton()!.click();
		});
		await settle(
			() =>
				document.body.textContent?.includes(
					"Could not open this project. Check folder access and try again."
				) ?? false
		);
		expect(selected).toEqual([]);
		expect(closes).toBe(0);
		expect(useWorkspaceStore.getState().folder).toBeNull();
		expect(openButton()).not.toBeNull();
		expect(searchFieldFocused()).toBe(true);
		status = 200;
		await act(async () => {
			openButton()!.click();
		});
		await settle(() => selected.length === 1);
		expect(selected).toEqual(["/new"]);
		expect(closes).toBe(1);
		expect(useWorkspaceStore.getState().folder).toBe("/new");
		expect(localStorage.getItem(folderKey)).toBe("/new");
		expect(document.body.textContent).not.toContain(
			"Could not open this project"
		);
		expect(outstanding).toBe(0);
	} finally {
		release?.();
		await settle(() => outstanding === 0);
		useNodeStore.subscribe = subscribe;
		await act(async () => root.unmount());
		container.remove();
	}
});

test("a superseded Core rejection cannot fail a newer acknowledged selection", async () => {
	status = 403;
	acknowledge = new Promise<void>((resolve) => {
		release = resolve;
	});
	const pending = useWorkspaceStore
		.getState()
		.setFolder("/new")
		.then(
			(acknowledged) => acknowledged,
			(error) => error
		);
	pendingSelection = pending;
	for (let attempt = 0; requests.length === 0 && attempt < 100; attempt++) {
		await Bun.sleep(5);
	}
	expect(requests).toHaveLength(1);
	status = 200;
	expect(await useWorkspaceStore.getState().setFolder("/newer")).toBe(true);
	const selected = useWorkspaceStore.getState();
	const before = bytes();
	release?.();
	release = null;
	expect(await pending).toBe(false);
	expect(useWorkspaceStore.getState()).toBe(selected);
	expect(bytes()).toEqual(before);
	expect(selected.folder).toBe("/newer");
});

for (const kind of ["create", "clone"] as const) {
	for (const mode of [
		"node-switch",
		"delegation-rotation",
		"tab-policy",
	] as const) {
		test(`mounted ${kind} ${mode} conserves authority and acknowledges only the current operation`, async () => {
			Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
			const { act, createElement } = await import("react");
			const { createRoot } = await import("react-dom/client");
			const { CurrentTabIdProvider } = await import(
				"../contexts/TabsContext.tsx"
			);
			const { setNodeTabOverride } = await import(
				"../hooks/useNodeDisplayMode.ts"
			);
			const { CreateFolderDialog, CloneFolderDialog } = await import(
				"../components/chat/ProjectPicker.tsx"
			);
			const Component =
				kind === "create" ? CreateFolderDialog : CloneFolderDialog;
			const selected: string[] = [];
			const changes: boolean[] = [];
			const container = document.createElement("div");
			document.body.append(container);
			const root = createRoot(container);
			const renderDialog = (open: boolean) =>
				root.render(
					createElement(CurrentTabIdProvider, {
						tabId: "fixture-tab",
						children: createElement(Component, {
							open,
							onOpenChange: (value: boolean) => changes.push(value),
							onFolderSelected: (folder: string) => selected.push(folder),
						}),
					})
				);
			async function settle(predicate: () => boolean) {
				for (let attempt = 0; !predicate() && attempt < 100; attempt++) {
					await act(async () => {
						await Bun.sleep(5);
					});
				}
				expect(predicate()).toBe(true);
			}
			const field = () =>
				document.querySelector<HTMLInputElement>(
					kind === "create"
						? 'input[placeholder="New project name"]'
						: 'input[aria-label="Repository URL"]'
				);
			const button = () =>
				Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
					(button) =>
						button.textContent?.includes(
							kind === "create" ? "Create project" : "Clone repository"
						)
				);
			try {
				if (mode === "tab-policy") {
					setNodeTabOverride(false);
					useNodeStore.setState({
						nodes: [
							...useNodeStore.getState().nodes,
							{
								name: "alternate",
								url: alternateServer.url.origin,
								token: "alternate-token",
								userJwt: "alternate-delegation",
							},
						],
						tabOverrides: { "fixture-tab": "alternate" },
					});
				}
				await act(async () => renderDialog(true));
				expect(field()).not.toBeNull();
				await act(async () => {
					const input = field()!;
					Object.getOwnPropertyDescriptor(
						HTMLInputElement.prototype,
						"value"
					)!.set!.call(
						input,
						kind === "create"
							? "created"
							: "https://git.example.test/team/created.git"
					);
					input.dispatchEvent(new Event("input", { bubbles: true }));
				});
				expect(button()?.disabled).toBe(false);
				if (mode === "delegation-rotation") {
					await act(async () =>
						useNodeStore.setState({
							nodes: [
								{
									...LOCAL_FALLBACK,
									token: "workspace-fixture-token",
									userJwt: "rotated-delegation",
								},
							],
						})
					);
				} else {
					postAcknowledgement = new Promise<void>((resolve) => {
						postRelease = resolve;
					});
				}
				await act(async () => button()!.click());
				await settle(() => posts.length === 1);
				expect(posts[0]?.url).toBe(
					new URL(
						kind === "create"
							? "/api/workspace/new-folder"
							: "/api/workspace/clone",
						server.url
					).href
				);
				expect(posts[0]?.bearer).toBe("Bearer workspace-fixture-token");
				expect(posts[0]?.body).toEqual(
					kind === "create"
						? { name: "created" }
						: {
								url: "https://git.example.test/team/created.git",
								name: "created",
							}
				);
				if (mode === "delegation-rotation") {
					expect(posts[0]?.delegation).toBe("rotated-delegation");
					await settle(() => selected.length === 1);
					expect(selected).toEqual(["/new"]);
					expect(changes).toEqual([false]);
				} else {
					if (mode === "tab-policy") {
						await act(async () => setNodeTabOverride(true));
					} else {
						const originalNodes = useNodeStore.getState().nodes;
						await act(async () =>
							useNodeStore.setState({
								nodes: [
									...originalNodes,
									{
										name: "alternate",
										url: alternateServer.url.origin,
										token: "alternate-token",
										userJwt: "alternate-delegation",
									},
								],
								defaultNode: "alternate",
							})
						);
						await act(async () =>
							useNodeStore.setState({ defaultNode: LOCAL_FALLBACK.name })
						);
					}
					const before = bytes();
					postRelease?.();
					postRelease = null;
					await settle(() => completedPosts === 1);
					await act(async () => {
						await Bun.sleep(20);
					});
					expect(selected).toEqual([]);
					expect(changes).toEqual([]);
					expect(bytes()).toEqual(before);
					expect(useWorkspaceStore.getState().folder).toBe("/existing");
					if (mode === "tab-policy") {
						// Moving the tab to another computer re-creates its surfaces
						// under that computer's history, so the retired computer's draft
						// is not carried over; the user enters it again for the retry.
						expect(field()?.value).toBe("");
						expect(field()?.disabled).toBe(false);
						await act(async () => {
							const input = field()!;
							Object.getOwnPropertyDescriptor(
								HTMLInputElement.prototype,
								"value"
							)!.set!.call(
								input,
								kind === "create"
									? "created"
									: "https://git.example.test/team/created.git"
							);
							input.dispatchEvent(new Event("input", { bubbles: true }));
						});
					} else {
						expect(field()?.value).toBe(
							kind === "create"
								? "created"
								: "https://git.example.test/team/created.git"
						);
						expect(field()?.disabled).toBe(false);
					}
					postAcknowledgement = null;
					if (mode !== "tab-policy") {
						await act(async () =>
							useNodeStore.setState({ defaultNode: "alternate" })
						);
					}
					await act(async () => button()!.click());
					await settle(() => selected.length === 1);
					expect(posts).toHaveLength(2);
					expect(posts[1]?.url).toBe(
						new URL(
							kind === "create"
								? "/api/workspace/new-folder"
								: "/api/workspace/clone",
							alternateServer.url
						).href
					);
					expect(posts[1]?.body).toEqual(posts[0]?.body);
					expect(posts[1]?.bearer).toBe("Bearer alternate-token");
					expect(posts[1]?.delegation).toBe("alternate-delegation");
					expect(selected).toEqual(["/newer"]);
					expect(changes).toEqual([false]);
					expect(useWorkspaceStore.getState().folder).toBe("/newer");
					expect(localStorage.getItem(folderKey)).toBe("/newer");
					if (mode === "tab-policy") {
						expect(requests).toHaveLength(0);
						// Carry the same live operation fence through the subsequent directory read,
						// including a policy A-B-A transition after the remote mutation has completed.
						await act(async () => renderDialog(false));
						await act(async () => renderDialog(true));
						await act(async () => setNodeTabOverride(false));
						await act(async () => {
							const input = field()!;
							Object.getOwnPropertyDescriptor(
								HTMLInputElement.prototype,
								"value"
							)!.set!.call(
								input,
								kind === "create"
									? "created"
									: "https://git.example.test/team/created.git"
							);
							input.dispatchEvent(new Event("input", { bubbles: true }));
						});
						acknowledge = new Promise<void>((resolve) => {
							release = resolve;
						});
						const subscribe = useNodeStore.subscribe;
						let ownedSubscriptions = 0;
						useNodeStore.subscribe = (listener) => {
							const dispose = subscribe(listener);
							ownedSubscriptions++;
							return () => {
								ownedSubscriptions--;
								dispose();
							};
						};
						try {
							await act(async () => button()!.click());
							await settle(() => requests.length === 1);
							expect(ownedSubscriptions).toBe(2);
							await act(async () => setNodeTabOverride(true));
							await act(async () => setNodeTabOverride(false));
							const prior = bytes();
							const state = useWorkspaceStore.getState();
							release?.();
							release = null;
							await settle(() => ownedSubscriptions === 0);
							expect(selected).toEqual(["/newer"]);
							expect(changes).toEqual([false]);
							expect(useWorkspaceStore.getState()).toBe(state);
							expect(bytes()).toEqual(prior);
							expect(state.folder).toBe("/newer");
						} finally {
							release?.();
							release = null;
							await settle(() => ownedSubscriptions === 0);
							useNodeStore.subscribe = subscribe;
						}
					}
				}
			} finally {
				postRelease?.();
				postRelease = null;
				await act(async () => root.unmount());
				container.remove();
			}
		});
	}
}

for (const kind of ["create", "clone"] as const) {
	test(`mounted ${kind} closes and reopens without retaining old busy state or subscriptions`, async () => {
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
		const { act, createElement } = await import("react");
		const { createRoot } = await import("react-dom/client");
		const { CreateFolderDialog, CloneFolderDialog } = await import(
			"../components/chat/ProjectPicker.tsx"
		);
		const Component =
			kind === "create" ? CreateFolderDialog : CloneFolderDialog;
		const selected: string[] = [];
		const changes: boolean[] = [];
		const originalSubscribe = useNodeStore.subscribe;
		let active = 0;
		useNodeStore.subscribe = (listener) => {
			const dispose = originalSubscribe(listener);
			active++;
			return () => {
				active--;
				dispose();
			};
		};
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const render = (open: boolean) =>
			root.render(
				createElement(Component, {
					open,
					onOpenChange: (value: boolean) => changes.push(value),
					onFolderSelected: (folder: string) => selected.push(folder),
				})
			);
		const field = () =>
			document.querySelector<HTMLInputElement>(
				kind === "create"
					? 'input[placeholder="New project name"]'
					: 'input[aria-label="Repository URL"]'
			);
		const button = () =>
			Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
				(button) =>
					button.textContent?.includes(
						kind === "create" ? "Create project" : "Clone repository"
					)
			);
		async function settle(predicate: () => boolean) {
			for (let attempt = 0; !predicate() && attempt < 100; attempt++) {
				await act(async () => {
					await Bun.sleep(5);
				});
			}
			expect(predicate()).toBe(true);
		}
		async function fill() {
			await act(async () => {
				const input = field()!;
				Object.getOwnPropertyDescriptor(
					HTMLInputElement.prototype,
					"value"
				)!.set!.call(
					input,
					kind === "create"
						? "created"
						: "https://git.example.test/team/created.git"
				);
				input.dispatchEvent(new Event("input", { bubbles: true }));
			});
		}
		try {
			await act(async () => render(true));
			const normalSubscriptions = active;
			await fill();
			postAcknowledgement = new Promise<void>((resolve) => {
				postRelease = resolve;
			});
			const before = bytes();
			await act(async () => button()!.click());
			await settle(() => posts.length === 1);
			expect(active).toBe(normalSubscriptions + 1);
			await act(async () => render(false));
			expect(active).toBe(normalSubscriptions);
			await act(async () => render(true));
			expect(field()?.disabled).toBe(false);
			expect(field()?.value).toBe("");
			postRelease?.();
			postRelease = null;
			await settle(() => completedPosts === 1);
			await act(async () => {
				await Bun.sleep(20);
			});
			expect(selected).toEqual([]);
			expect(changes).toEqual([]);
			expect(bytes()).toEqual(before);
			postAcknowledgement = null;
			await fill();
			await act(async () => button()!.click());
			await settle(() => selected.length === 1);
			expect(posts).toHaveLength(2);
			expect(selected).toEqual(["/new"]);
			expect(changes).toEqual([false]);
			expect(useWorkspaceStore.getState().folder).toBe("/new");
			expect(active).toBe(normalSubscriptions);
		} finally {
			postRelease?.();
			postRelease = null;
			await act(async () => root.unmount());
			container.remove();
			useNodeStore.subscribe = originalSubscribe;
			expect(active).toBe(0);
		}
	});
}

test("mounted recent selection cannot acknowledge an event-time node getter after tab policy changes", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const { act, createElement } = await import("react");
	const { createRoot } = await import("react-dom/client");
	const { ProjectCommandDialog } = await import(
		"../components/chat/ProjectPicker.tsx"
	);
	const { CurrentTabIdProvider } = await import("../contexts/TabsContext.tsx");
	const { setNodeTabOverride } = await import("../hooks/useNodeDisplayMode.ts");
	useWorkspaceStore.getState().addProjectFolder("/new");
	setNodeTabOverride(false);
	useNodeStore.setState({
		nodes: [
			...useNodeStore.getState().nodes,
			{
				name: "alternate",
				url: alternateServer.url.origin,
				token: "alternate-token",
				userJwt: "alternate-delegation",
			},
		],
		tabOverrides: { "fixture-tab": "alternate" },
	});
	const selected: string[] = [];
	let closes = 0;
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	async function settle(predicate: () => boolean) {
		for (let attempt = 0; !predicate() && attempt < 100; attempt++) {
			await act(async () => {
				await Bun.sleep(5);
			});
		}
		expect(predicate()).toBe(true);
	}
	try {
		await act(async () =>
			root.render(
				createElement(CurrentTabIdProvider, {
					tabId: "fixture-tab",
					children: createElement(ProjectCommandDialog, {
						onFolderSelected: (folder: string) => selected.push(folder),
						onOpenChange: (open: boolean) => {
							if (!open) {
								closes++;
							}
						},
						open: true,
					}),
				})
			)
		);
		acknowledge = new Promise<void>((resolve) => {
			release = resolve;
		});
		const subscribe = useNodeStore.subscribe;
		let reads = 0;
		useNodeStore.subscribe = (listener) => {
			const dispose = subscribe(listener);
			reads++;
			return () => {
				reads--;
				dispose();
			};
		};
		try {
			await act(async () =>
				document
					.querySelector<HTMLElement>('[role="option"][aria-label="Open new"]')!
					.click()
			);
			await settle(() => requests.length === 1);
			await act(async () => setNodeTabOverride(true));
			const before = bytes();
			const state = useWorkspaceStore.getState();
			release?.();
			release = null;
			await settle(() => reads === 0);
			expect(useWorkspaceStore.getState()).toBe(state);
			expect(bytes()).toEqual(before);
			expect(selected).toEqual([]);
			expect(closes).toBe(0);
		} finally {
			release?.();
			release = null;
			await settle(() => reads === 0);
			useNodeStore.subscribe = subscribe;
		}
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
});

test("mounted browsed selection cannot publish a directory acknowledgement after tab policy changes", async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const { act, createElement } = await import("react");
	const { createRoot } = await import("react-dom/client");
	const { ProjectPicker } = await import(
		"../components/chat/ProjectPicker.tsx"
	);
	const { CurrentTabIdProvider } = await import("../contexts/TabsContext.tsx");
	const { setNodeTabOverride } = await import("../hooks/useNodeDisplayMode.ts");
	setNodeTabOverride(false);
	browseListing = true;
	useNodeStore.setState({
		nodes: [
			...useNodeStore.getState().nodes,
			{
				name: "alternate",
				url: alternateServer.url.origin,
				token: "alternate-token",
				userJwt: "alternate-delegation",
			},
		],
		tabOverrides: { "fixture-tab": "alternate" },
	});
	const selected: string[] = [];
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	async function settle(predicate: () => boolean) {
		for (let attempt = 0; !predicate() && attempt < 100; attempt++) {
			await act(async () => {
				await Bun.sleep(5);
			});
		}
		expect(predicate()).toBe(true);
	}
	try {
		await act(async () =>
			root.render(
				createElement(CurrentTabIdProvider, {
					tabId: "fixture-tab",
					children: createElement<
						NonNullable<Parameters<typeof ProjectPicker>[0]>
					>(ProjectPicker, {
						onFolderSelected: (folder: string) => selected.push(folder),
					}),
				})
			)
		);
		await act(async () =>
			document
				.querySelector<HTMLButtonElement>(
					'button[aria-label="Select project folder"]'
				)!
				.click()
		);
		// The picker is a command dialog; "New project" is one of its options.
		await settle(() =>
			Array.from(
				document.querySelectorAll<HTMLElement>('[role="option"]')
			).some((item) => item.textContent?.trim() === "New project")
		);
		await act(async () =>
			Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
				.find((item) => item.textContent?.trim() === "New project")!
				.click()
		);
		await settle(() =>
			Array.from(
				document.querySelectorAll<HTMLElement>('[role="option"]')
			).some((item) => item.textContent?.includes("New fixture"))
		);
		await act(async () =>
			Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
				.find((item) => item.textContent?.includes("New fixture"))!
				.click()
		);
		const confirmation = () =>
			Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
				(button) => button.textContent?.trim() === "Add folder to Ryu"
			);
		await settle(() => confirmation()?.disabled === false);
		const earlierRequests = requests.length;
		acknowledge = new Promise<void>((resolve) => {
			release = resolve;
		});
		const subscribe = useNodeStore.subscribe;
		let reads = 0;
		useNodeStore.subscribe = (listener) => {
			const dispose = subscribe(listener);
			reads++;
			return () => {
				reads--;
				dispose();
			};
		};
		try {
			await act(async () => confirmation()!.click());
			await settle(() => requests.length === earlierRequests + 1);
			await act(async () => setNodeTabOverride(true));
			const before = bytes();
			const state = useWorkspaceStore.getState();
			release?.();
			release = null;
			await settle(() => reads === 0);
			expect(useWorkspaceStore.getState()).toBe(state);
			expect(bytes()).toEqual(before);
			expect(selected).toEqual([]);
		} finally {
			release?.();
			release = null;
			await settle(() => reads === 0);
			useNodeStore.subscribe = subscribe;
		}
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
});
