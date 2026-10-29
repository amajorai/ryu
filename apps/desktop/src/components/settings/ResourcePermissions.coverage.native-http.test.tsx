// biome-ignore-all lint/suspicious/noMisplacedAssertion: the shared teardown asserts every case left no undeclared Core request.
// ResourcePermissions against a loopback Core peer that serves the real ACL
// vocabulary, principal directory and per-resource overwrite routes. The
// active node comes from the real node store; every rule edit is made through
// the rendered target pickers, permission rows and group disclosures, and every
// effect is read back from what Core received or now holds.
import {
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import {
	button,
	buttons,
	type CorePeer,
	click,
	flush,
	installAnimationApis,
	isDisabled,
	maybeButton,
	normalized,
	openOptionLabels,
	type PeerCall,
	registerDomWithNativeNetworking,
	startCorePeer,
	text,
	until,
} from "./models-plugins-settings.test-support.ts";

registerDomWithNativeNetworking();
installAnimationApis();
setDefaultTimeout(30_000);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { sileo } = await import("sileo");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { ResourcePermissions } = await import("./ResourcePermissions.tsx");

const TOKEN = "resource-permissions-token";
const RESOURCE = "/api/acl/resources/space/space-design";
const OTHER = "/api/acl/resources/space/space-other";
const initialNodeState = useNodeStore.getState();

interface Overwrite {
	allow: string[];
	deny: string[];
	target_id: string;
	target_type: "org" | "team" | "role" | "member";
}

interface CoreState {
	directory: unknown;
	directoryStatus: number;
	overwrites: Record<string, Overwrite[]>;
	vocabulary: unknown;
}

let core: CoreState;
let peer: CorePeer;
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement;

const VOCABULARY = {
	kernel: ["space.edit", "space.view"],
	declared: [
		{
			id: "space.view",
			label: "View items",
			description: "",
			implies: [],
			plugin_id: "",
		},
		{
			id: "space.edit",
			label: "Edit items",
			description: "",
			implies: [],
			plugin_id: "",
		},
		{
			id: "wf.run",
			label: "Run workflows",
			description: "Start a workflow in this space.",
			implies: ["wf.view"],
			plugin_id: "com.ryu.workflows",
		},
		{
			id: "wf.view",
			label: "See workflows",
			description: "",
			implies: [],
			plugin_id: "com.ryu.workflows",
		},
		{
			id: "wf.admin",
			label: "Administer workflows",
			description: "",
			implies: ["wf.run"],
			plugin_id: "com.ryu.workflows",
		},
		// An app that names a built-in key: Core drops its edges.
		{
			id: "space.view",
			label: "View items",
			description: "",
			implies: ["wf.admin"],
			plugin_id: "com.thirdparty.viewer",
		},
	],
	collisions: ["space.view"],
};

const DIRECTORY = {
	org_id: "org-acme",
	kinds: ["space"],
	roles: [{ id: "role-editor", label: "Editors" }],
	teams: [{ id: "team-design", name: "Design" }],
	members: [{ id: "user-kai", name: "Kai", email: "kai@acme.test" }],
};

function route(call: PeerCall) {
	if (call.authorization !== `Bearer ${TOKEN}`) {
		return { status: 401, body: { error: "unauthorized" } };
	}
	if (call.method === "GET" && call.path === "/api/acl/vocabulary") {
		return { body: core.vocabulary };
	}
	if (call.method === "GET" && call.path === "/api/acl/principals") {
		return core.directoryStatus === 200
			? { body: core.directory }
			: { status: core.directoryStatus, body: { error: "no directory" } };
	}
	if (call.path.startsWith("/api/acl/resources/space/")) {
		if (call.method === "GET") {
			return { body: { overwrites: core.overwrites[call.path] ?? [] } };
		}
		if (call.method === "PUT") {
			core.overwrites[call.path] = (
				call.body as { overwrites: Overwrite[] }
			).overwrites;
			return { body: { ok: true } };
		}
	}
	return;
}

async function mount() {
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<>
				<ResourcePermissions
					resourceId="space-design"
					resourceKind="space"
					resourceName="Design space"
				/>
				<Toaster />
			</>
		)
	);
	await until(
		() => text().includes("Permissions — Design space"),
		"permissions loaded"
	);
}

function puts() {
	return peer.calls.filter((call) => call.method === "PUT");
}

/** The rule card (`li`) whose target label reads `label`. */
function card(label: string): HTMLElement {
	const found = [...container.querySelectorAll<HTMLElement>("li")].find(
		(item) => normalized(item.querySelector("label")) === label
	);
	if (!found) {
		throw new Error(`Missing ${label} rule: ${text()}`);
	}
	return found;
}

/** The Allow/Inherit/Deny row for one permission inside a rule card. */
function permissionRow(scope: HTMLElement, label: string): HTMLElement {
	const row = [...scope.querySelectorAll<HTMLElement>("p")]
		.find((paragraph) => normalized(paragraph) === label)
		?.closest<HTMLElement>(".flex.items-start");
	if (!row) {
		throw new Error(`Missing ${label} permission row: ${normalized(scope)}`);
	}
	return row;
}

/** The disclosure trigger of one permission group inside a rule card. */
function groupTrigger(scope: HTMLElement, title: string): HTMLElement {
	const trigger = [
		...scope.querySelectorAll<HTMLElement>("[aria-expanded]"),
	].find((candidate) => normalized(candidate).startsWith(title));
	if (!trigger) {
		throw new Error(`Missing ${title} group: ${normalized(scope)}`);
	}
	return trigger;
}

async function pickTarget(scope: HTMLElement, label: string) {
	const combo = scope.querySelector<HTMLElement>('[role="combobox"]');
	if (!combo) {
		throw new Error(`Missing target picker: ${normalized(scope)}`);
	}
	await act(async () => combo.click());
	await until(
		() => openOptionLabels().some((option) => option.startsWith(label)),
		`target option ${label}`,
		5000,
		() => openOptionLabels().join(" | ")
	);
	const option = [
		...document.querySelectorAll<HTMLElement>('[role="option"]'),
	].find((candidate) => normalized(candidate).startsWith(label));
	await act(async () => option?.click());
	await flush();
}

beforeEach(() => {
	core = {
		vocabulary: VOCABULARY,
		directory: DIRECTORY,
		directoryStatus: 200,
		overwrites: {
			[OTHER]: [
				{
					target_type: "role",
					target_id: "role-editor",
					allow: ["space.view"],
					deny: [],
				},
			],
		},
	};
	peer = startCorePeer(route);
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: "resource-permissions-coverage",
		nodes: [
			{
				name: "resource-permissions-coverage",
				token: TOKEN,
				url: peer.url,
				userJwt: "resource-permissions-user",
			},
		],
		tabOverrides: {},
	});
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(async () => {
	await act(async () => {
		root?.unmount();
		sileo.clear();
	});
	root = null;
	container.remove();
	document.body.replaceChildren();
	useNodeStore.setState(initialNodeState, true);
	peer.stop();
	expect(peer.unexpected).toEqual([]);
	// Another resource's rules are never touched.
	expect(core.overwrites[OTHER]).toEqual([
		{
			target_type: "role",
			target_id: "role-editor",
			allow: ["space.view"],
			deny: [],
		},
	]);
});

test("app permission groups start collapsed with their count, open on demand, state what a Deny drags with it, and note an app that named a built-in key", async () => {
	core.overwrites[RESOURCE] = [
		{ target_type: "team", target_id: "team-design", allow: [], deny: [] },
	];
	await mount();
	expect(text()).toContain(
		"Note: some app rules for space.view were ignored. An app can't change a built-in permission, a level another app owns, or a level two installed apps both declare."
	);
	const team = card("Team");
	const workflows = groupTrigger(team, "Workflows");
	expect(workflows.getAttribute("aria-expanded")).toBe("false");
	expect(normalized(workflows)).toContain("3 available");
	// Built-ins start open.
	expect(groupTrigger(team, "Built in").getAttribute("aria-expanded")).toBe(
		"true"
	);

	await click(workflows);
	await until(
		() =>
			groupTrigger(card("Team"), "Workflows").getAttribute("aria-expanded") ===
			"true",
		"workflow group opened"
	);
	const run = () => permissionRow(card("Team"), "Run workflows");
	// Allowing Run also allows See (its implied edge).
	expect(normalized(run())).toContain(
		"Allowing this also allows: See workflows"
	);
	await click(button("Deny", run()));
	await until(
		() =>
			normalized(run()).includes(
				"Denying this also denies: Administer workflows"
			),
		"deny consequence"
	);
	expect(normalized(run())).not.toContain("Allowing this also allows");
	expect(normalized(groupTrigger(card("Team"), "Workflows"))).toContain(
		"1 set"
	);
	// The collided built-in kept no app edge: viewing does not drag admin.
	expect(normalized(permissionRow(card("Team"), "View items"))).not.toContain(
		"Administer workflows"
	);

	await click(button("Save"));
	await until(() => puts().length === 1, "rule saved");
	expect(core.overwrites[RESOURCE]).toEqual([
		{
			target_type: "team",
			target_id: "team-design",
			allow: [],
			deny: ["wf.run"],
		},
	]);
	await until(() => text().includes("Permissions saved"), "save toast");
});

test("a rule naming someone who left the organisation keeps them as a labelled choice and saves unchanged; a personal node with no directory explains the manual identifier", async () => {
	core.overwrites[RESOURCE] = [
		{
			target_type: "member",
			target_id: "user-gone",
			allow: ["space.view"],
			deny: [],
		},
	];
	await mount();
	const person = card("Person");
	const combo = person.querySelector<HTMLElement>('[role="combobox"]');
	expect(normalized(combo)).toContain("user-gone");
	await act(async () => combo?.click());
	await until(() => openOptionLabels().length > 0, "member options");
	// Each option is its label followed by its hint line.
	expect(openOptionLabels()).toEqual([
		"Kaikai@acme.test",
		"user-goneNo longer in this organisation",
	]);
	await act(async () => {
		document.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
		);
	});
	await flush();
	await click(button("Allow", permissionRow(card("Person"), "Edit items")));
	await click(button("Save"));
	await until(() => puts().length === 1, "rule saved");
	expect(core.overwrites[RESOURCE]).toEqual([
		{
			target_type: "member",
			target_id: "user-gone",
			allow: ["space.view", "space.edit"],
			deny: [],
		},
	]);

	// A personal node answers with an empty directory and no org.
	await act(async () => root?.unmount());
	core.directory = {
		org_id: null,
		kinds: ["space"],
		roles: [],
		teams: [],
		members: [],
	};
	core.overwrites[RESOURCE] = [];
	await mount();
	expect(isDisabled(button("Add everyone in the org"))).toBe(true);
	await click(button("Add role"));
	expect(text()).toContain(
		"This node listed no roles, which is normal on a personal node that belongs to no organisation."
	);
	expect(text()).not.toContain("did not send anything to choose from");
	expect(
		container.querySelector('input[aria-label="Role identifier"]')
	).not.toBeNull();
});

test("a rule with settings but no target keeps Save locked with guidance; choosing a target unlocks it and rules that set nothing are dropped from the write", async () => {
	core.overwrites[RESOURCE] = [];
	await mount();
	expect(text()).toContain("No exceptions. Everyone follows their usual role.");
	expect(isDisabled(button("Save"))).toBe(true);

	await click(button("Add team"));
	await click(button("Add role"));
	expect(buttons("Remove")).toHaveLength(2);
	await click(button("Allow", permissionRow(card("Team"), "View items")));
	expect(text()).toContain(
		"Pick who this applies to. Until then these settings do nothing."
	);
	expect(isDisabled(button("Save"))).toBe(true);
	await click(button("Save"));
	expect(puts()).toEqual([]);

	await pickTarget(card("Team"), "Design");
	expect(isDisabled(button("Save"))).toBe(false);
	await click(button("Save"));
	await until(() => puts().length === 1, "rule saved");
	// The empty Role rule set nothing, so it is not persisted as a dead rule.
	expect(puts()[0].body).toEqual({
		overwrites: [
			{
				target_type: "team",
				target_id: "team-design",
				allow: ["space.view"],
				deny: [],
			},
		],
	});
	await until(
		() => maybeButton("Save") !== null && isDisabled(button("Save")),
		"saved state reread"
	);
	// Core's reread replaces the draft: only the persisted rule remains.
	expect(buttons("Remove")).toHaveLength(1);
});
