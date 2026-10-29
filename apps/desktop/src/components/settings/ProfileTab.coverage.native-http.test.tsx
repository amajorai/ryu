import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
	spyOn,
	test,
} from "bun:test";
import {
	button,
	click,
	input,
	installAccountBillingDom,
	maybeButton,
	press,
	settle,
	text,
	textarea,
	type,
	until as untilPage,
} from "./account-billing.native-http.dom.ts";
import {
	signUp,
	startAccountPeer,
	startNodePeer,
} from "./account-billing.native-http.helpers.ts";

// Mounts the shipping Profile tab with the shipping session, settings,
// preference and profile clients. The account side is a real Better Auth
// server plus the profile routes from `packages/api/src/routers/profile.ts`;
// the "About you" details live on two Core node peers (`north`, `south`),
// each demanding its own bearer, selected through the shipping node store.
// Effects are read back from the node and account stores and by remounting.
installAccountBillingDom();
setDefaultTimeout(30_000);

const peer = startAccountPeer();
const nodes = startNodePeer(["north", "south"]);
process.env.VITE_APP_BACKEND_URL = peer.origin;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClientProvider } = await import("@tanstack/react-query");
const { sileo } = await import("sileo");
const { queryClient } = await import("@/src/lib/query-client.ts");
const { authClient, TOKEN_KEY } = await import("@/lib/auth-client.ts");
const { LOCAL_FALLBACK, useNodeStore } = await import(
	"@/src/store/useNodeStore.ts"
);
const { ProfileTab } = await import("./ProfileTab.tsx");

const PERSONALIZATION = "/api/preferences/user-personalization";
const PREF_KEY = "user-personalization";
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;
let errorToast: ReturnType<typeof spyOn<typeof sileo, "error">>;
let successToast: ReturnType<typeof spyOn<typeof sileo, "success">>;
const runtimeErrors: string[] = [];
let counter = 0;

function until(predicate: () => boolean, reason: string, ms = 8000) {
	return untilPage(predicate, reason, ms, () =>
		[...peer.calls.slice(-5), ...nodes.calls.slice(-5)]
			.map((call) => `${call.method} ${call.path} ${call.status}`)
			.join("\n")
	);
}
function errorTitles() {
	return errorToast.mock.calls.map((call) => String(call[0]?.title ?? ""));
}
function successTitles() {
	return successToast.mock.calls.map((call) => String(call[0]?.title ?? ""));
}
function nodeFor(name: string) {
	return {
		...LOCAL_FALLBACK,
		name,
		token: nodes.tokenFor(name),
		url: nodes.urlFor(name),
		userJwt: null,
	};
}
async function select(name: string) {
	const list = [nodeFor("north"), nodeFor("south")];
	await act(async () => {
		useNodeStore.setState({
			autoSelect: false,
			autoSelectedNode: null,
			cloudNodes: [],
			defaultNode: name,
			localNodes: list,
			nodes: list,
			tabOverrides: {},
		});
	});
}
function personalizationOn(node: string): Record<string, unknown> | null {
	const raw = nodes.preferences[node]?.get(PREF_KEY);
	return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}
function writesTo(node: string, path: string) {
	return nodes.calls.filter(
		(call) => call.node === node && call.method === "PUT" && call.path === path
	);
}
function fields() {
	return {
		aboutOrganization: textarea('[aria-label="About your organization"]').value,
		aboutYou: textarea('[aria-label="More about you"]').value,
		nickname: input('[aria-label="Nickname"]').value,
		occupation: input('[aria-label="Occupation"]').value,
	};
}
async function account() {
	counter += 1;
	const email = `profile-${counter}@account.example.test`;
	const created = await signUp(peer, {
		email,
		name: `Profile Person ${counter}`,
		password: "profile-password-2026",
	});
	return { ...created, email, name: `Profile Person ${counter}` };
}
async function mount(token: string) {
	localStorage.setItem(TOKEN_KEY, token);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container, {
		onCaughtError: (error) => runtimeErrors.push(String(error)),
		onRecoverableError: (error) => runtimeErrors.push(String(error)),
		onUncaughtError: (error) => runtimeErrors.push(String(error)),
	});
	await act(async () =>
		root?.render(
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(ProfileTab)
			)
		)
	);
	await act(async () => {
		authClient.$store.notify("$sessionSignal");
	});
}
async function unmount() {
	await act(async () => root?.unmount());
	root = null;
	container?.remove();
	container = null;
	document.body.replaceChildren();
}
function personalizationReady() {
	const nickname = document.querySelector<HTMLInputElement>(
		'[aria-label="Nickname"]'
	);
	return Boolean(nickname && !nickname.disabled);
}

function cacheDialog() {
	return document.querySelector<HTMLElement>('[role="alertdialog"]');
}
function saveIdle() {
	return maybeButton("Save personalization") !== undefined;
}
// About you reaches every owner thread's system prompt, so a changed save asks
// to reset the prompt cache before writing.
async function applyCacheReset() {
	await until(() => cacheDialog() !== null, "prompt-cache confirm never shown");
	await click(button("Apply now"));
}

beforeEach(async () => {
	runtimeErrors.length = 0;
	peer.calls.length = 0;
	peer.unknown.length = 0;
	nodes.calls.length = 0;
	nodes.unknown.length = 0;
	for (const store of Object.values(nodes.preferences)) {
		store.clear();
	}
	localStorage.clear();
	await act(async () => {
		await queryClient.cancelQueries();
		queryClient.clear();
	});
	errorToast = spyOn(sileo, "error");
	successToast = spyOn(sileo, "success");
	await select("north");
});

afterEach(async () => {
	await unmount();
	errorToast.mockRestore();
	successToast.mockRestore();
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case refuses undeclared routes and wrong node authority.
	expect([...peer.unknown, ...nodes.unknown]).toEqual([]);
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must render without React errors.
	expect(runtimeErrors).toEqual([]);
});

afterAll(() => {
	peer.stop();
	nodes.stop();
	localStorage.clear();
});

test("Your name: a blank name is never sent, Enter saves the trimmed name to the account, a refusal keeps the draft, and a remount reads the saved name back", async () => {
	const person = await account();
	await mount(person.token);
	const name = () => input('input[placeholder="Your name"]');
	await until(() => name().value === person.name, "session name never shown");
	const save = () => button("Save");

	await type(name(), "   ");
	expect(save().disabled).toBe(true);
	await press(name(), "Enter");
	await settle(50);
	expect(
		peer.calls.filter((call) => call.path === "/api/profile/name")
	).toEqual([]);

	peer.refuseNext("PUT /api/profile/name", 503, "Profile service unavailable");
	await type(name(), "  Ada Lovelace  ");
	await press(name(), "Enter");
	await until(
		() => errorTitles().includes("Couldn't update your name"),
		"refusal not surfaced"
	);
	expect(name().value).toBe("  Ada Lovelace  ");
	const context = await peer.auth.$context;
	expect(
		(await context.internalAdapter.findUserById(person.userId))?.name
	).toBe(person.name);

	await click(save());
	await until(() => successTitles().includes("Name updated"), "name not saved");
	expect(
		peer.calls
			.filter((call) => call.path === "/api/profile/name")
			.map((call) => [call.body, call.status])
	).toEqual([
		[{ name: "Ada Lovelace" }, 503],
		[{ name: "Ada Lovelace" }, 200],
	]);
	expect(
		(await context.internalAdapter.findUserById(person.userId))?.name
	).toBe("Ada Lovelace");
	await until(() => name().value === "Ada Lovelace", "field not re-read");
	expect(save().disabled).toBe(true);

	await unmount();
	await mount(person.token);
	await until(
		() => name().value === "Ada Lovelace",
		"saved name not read back on remount"
	);
});

test("About you: Nickname, Occupation, More about you and About your organization save to the selected node only, keep that node's other saved details, and read back after a remount", async () => {
	nodes.preferences.north?.set(
		PREF_KEY,
		JSON.stringify({
			aboutOrganization: "North org",
			aboutYou: "North about",
			nickname: "Northy",
			occupation: "North job",
			pronouns: "they/them",
		})
	);
	const southBefore = JSON.stringify({
		aboutOrganization: "South org",
		aboutYou: "South about",
		nickname: "Southy",
		occupation: "South job",
	});
	nodes.preferences.south?.set(PREF_KEY, southBefore);
	const person = await account();
	await mount(person.token);
	await until(personalizationReady, "north details never loaded");
	expect(fields()).toEqual({
		aboutOrganization: "North org",
		aboutYou: "North about",
		nickname: "Northy",
		occupation: "North job",
	});

	await type(input('[aria-label="Nickname"]'), "Rae");
	await type(input('[aria-label="Occupation"]'), "Accessibility engineer");
	await type(
		textarea('[aria-label="More about you"]'),
		"I build accessible tools for public libraries."
	);
	await type(
		textarea('[aria-label="About your organization"]'),
		"Cedar Research Group"
	);
	await click(button("Save personalization"));
	await applyCacheReset();
	await until(
		() => successTitles().includes("Personalization saved"),
		"personalization not saved"
	);
	expect(personalizationOn("north")).toEqual({
		aboutOrganization: "Cedar Research Group",
		aboutYou: "I build accessible tools for public libraries.",
		nickname: "Rae",
		occupation: "Accessibility engineer",
		pronouns: "they/them",
	});
	expect(writesTo("north", PERSONALIZATION)).toHaveLength(1);
	expect(writesTo("south", PERSONALIZATION)).toEqual([]);
	expect(nodes.preferences.south?.get(PREF_KEY)).toBe(southBefore);

	await unmount();
	await mount(person.token);
	await until(personalizationReady, "north details never reloaded");
	expect(fields()).toEqual({
		aboutOrganization: "Cedar Research Group",
		aboutYou: "I build accessible tools for public libraries.",
		nickname: "Rae",
		occupation: "Accessibility engineer",
	});

	// Switching node shows that node's own details, not the edit just saved.
	await select("south");
	await until(
		() => personalizationReady() && fields().nickname === "Southy",
		"south details never shown"
	);
	expect(fields().occupation).toBe("South job");
});

test("About you: a slow read from the previously selected node never replaces the newly selected node's details, so a save writes only what that node showed", async () => {
	nodes.preferences.north?.set(
		PREF_KEY,
		JSON.stringify({
			aboutOrganization: "North org",
			aboutYou: "North about",
			nickname: "Northy",
			occupation: "North job",
		})
	);
	nodes.preferences.south?.set(
		PREF_KEY,
		JSON.stringify({
			aboutOrganization: "South org",
			aboutYou: "South about",
			nickname: "Southy",
			occupation: "South job",
		})
	);
	const person = await account();
	const releaseNorth = nodes.hold("north", "GET", PERSONALIZATION);
	await mount(person.token);
	await until(
		() =>
			nodes.calls.some(
				(call) => call.node === "north" && call.path === PERSONALIZATION
			),
		"north read never started"
	);
	await select("south");
	await until(
		() => personalizationReady() && fields().nickname === "Southy",
		"south details never shown"
	);
	releaseNorth();
	await settle(200);
	expect(fields()).toEqual({
		aboutOrganization: "South org",
		aboutYou: "South about",
		nickname: "Southy",
		occupation: "South job",
	});

	await type(input('[aria-label="Occupation"]'), "South lead");
	await click(button("Save personalization"));
	await applyCacheReset();
	await until(
		() => successTitles().includes("Personalization saved"),
		"south save not confirmed"
	);
	expect(personalizationOn("south")).toEqual({
		aboutOrganization: "South org",
		aboutYou: "South about",
		nickname: "Southy",
		occupation: "South lead",
	});
	expect(writesTo("north", PERSONALIZATION)).toEqual([]);
	expect(text()).not.toContain("Northy");
});

test("About you: a node whose saved details are unreadable shows empty fields, not the previous node's details", async () => {
	nodes.preferences.north?.set(
		PREF_KEY,
		JSON.stringify({
			aboutOrganization: "North org",
			aboutYou: "North about",
			nickname: "Northy",
			occupation: "North job",
		})
	);
	nodes.preferences.south?.set(PREF_KEY, "{not json");
	const person = await account();
	await mount(person.token);
	await until(
		() => personalizationReady() && fields().nickname === "Northy",
		"north details never shown"
	);
	await select("south");
	await until(
		() =>
			nodes.calls.filter(
				(call) => call.node === "south" && call.path === PERSONALIZATION
			).length === 1 && personalizationReady(),
		"south read never finished"
	);
	await settle(50);
	expect(fields()).toEqual({
		aboutOrganization: "",
		aboutYou: "",
		nickname: "",
		occupation: "",
	});
	await type(input('[aria-label="Nickname"]'), "Fresh start");
	await click(button("Save personalization"));
	await applyCacheReset();
	await until(
		() => successTitles().includes("Personalization saved"),
		"south save not confirmed"
	);
	expect(personalizationOn("south")).toEqual({
		aboutOrganization: "",
		aboutYou: "",
		nickname: "Fresh start",
		occupation: "",
	});
	expect(writesTo("north", PERSONALIZATION)).toEqual([]);
});

test("About you: a changed save asks before resetting every thread's prompt cache, Cancel writes nothing and keeps the draft, and an unchanged save writes without asking", async () => {
	const saved = JSON.stringify({
		aboutOrganization: "North org",
		aboutYou: "North about",
		nickname: "Northy",
		occupation: "North job",
	});
	nodes.preferences.north?.set(PREF_KEY, saved);
	const person = await account();
	await mount(person.token);
	await until(personalizationReady, "north details never loaded");

	// Unchanged (or whitespace-only) details do not change the prompt.
	await type(input('[aria-label="Nickname"]'), "Northy ");
	await click(button("Save personalization"));
	await until(
		() => successTitles().includes("Personalization saved"),
		"unchanged save not written"
	);
	expect(cacheDialog()).toBeNull();
	expect(writesTo("north", PERSONALIZATION)).toHaveLength(1);
	await until(saveIdle, "unchanged save never finished");

	await type(input('[aria-label="Occupation"]'), "North lead");
	await click(button("Save personalization"));
	await until(() => cacheDialog() !== null, "prompt-cache confirm never shown");
	const dialog = cacheDialog()?.textContent ?? "";
	expect(dialog).toContain("Apply now? This resets the prompt cache");
	expect(dialog).toContain(
		"Occupation is part of the system prompt for every thread on this node."
	);
	await click(button("Cancel"));
	await until(() => cacheDialog() === null, "confirm never closed");
	await settle(50);
	expect(writesTo("north", PERSONALIZATION)).toHaveLength(1);
	expect(personalizationOn("north")?.occupation).toBe("North job");
	expect(fields().occupation).toBe("North lead");

	await click(button("Save personalization"));
	await applyCacheReset();
	await until(
		() => personalizationOn("north")?.occupation === "North lead",
		"confirmed save not written"
	);
	expect(writesTo("north", PERSONALIZATION)).toHaveLength(2);
	await until(saveIdle, "confirmed save never finished");

	// The saved value is the new baseline: saving it again does not ask.
	await click(button("Save personalization"));
	await until(
		() => writesTo("north", PERSONALIZATION).length === 3,
		"repeat save not written"
	);
	expect(cacheDialog()).toBeNull();
});

test("About you: switching node while the prompt-cache confirm is open closes it, so the previous node's draft is never written to either node", async () => {
	nodes.preferences.north?.set(
		PREF_KEY,
		JSON.stringify({
			aboutOrganization: "",
			aboutYou: "",
			nickname: "Northy",
			occupation: "North job",
		})
	);
	nodes.preferences.south?.set(
		PREF_KEY,
		JSON.stringify({
			aboutOrganization: "",
			aboutYou: "",
			nickname: "Southy",
			occupation: "South job",
		})
	);
	const person = await account();
	await mount(person.token);
	await until(personalizationReady, "north details never loaded");
	await type(input('[aria-label="Occupation"]'), "North draft");
	await click(button("Save personalization"));
	await until(() => cacheDialog() !== null, "prompt-cache confirm never shown");

	const releaseSouth = nodes.hold("south", "GET", PERSONALIZATION);
	await select("south");
	await until(
		() =>
			nodes.calls.some(
				(call) => call.node === "south" && call.path === PERSONALIZATION
			),
		"south read never started"
	);
	// Closed while south is still loading, before any Apply could reach it.
	await until(() => cacheDialog() === null, "confirm stayed open");
	releaseSouth();
	await until(
		() => personalizationReady() && fields().nickname === "Southy",
		"south details never shown"
	);
	await settle(50);
	expect(writesTo("north", PERSONALIZATION)).toEqual([]);
	expect(writesTo("south", PERSONALIZATION)).toEqual([]);
});
