import { expect, test } from "bun:test";
import {
	act,
	alertDialog,
	button,
	calls,
	captionFor,
	confirmInput,
	errorToast,
	failDeepCleanFor,
	held,
	holds,
	idle,
	ipc,
	isLocalNode,
	maybeButton,
	mount,
	nativeCalls,
	nodeFor,
	optionsDialog,
	profileChoice,
	queryClient,
	refuse,
	registerDangerZoneHooks,
	release,
	reload,
	select,
	states,
	successToast,
	text,
	type,
	unmount,
	until,
	writes,
} from "./DangerZoneSettings.coverage.test-support.ts";

// Cases for the shipping Danger Zone against its owned native HTTP peer; the
// peer, the IPC bridge and the per-case closure checks live in the support file.
registerDangerZoneHooks();

test("Checking this node holds every delete until the selected node's counts arrive, a refused read keeps deletes disabled behind Retry, and the rows that appear are that node's", async () => {
	expect(isLocalNode(nodeFor("local"))).toBe(true);
	expect(isLocalNode(nodeFor("remote"))).toBe(false);
	held.add("remote:GET:/api/data/counts");
	await mount();
	await until(
		() => holds.has("remote:GET:/api/data/counts"),
		"The counts read did not reach the remote node"
	);
	expect(text()).toContain("Checking this node");
	expect(captionFor("Checking this node")).toBe("Loading…");
	expect(maybeButton("Delete all chats")?.textContent).toBeUndefined();
	release("remote:GET:/api/data/counts");
	await until(
		() => maybeButton("Delete all chats") !== undefined,
		"Remote counts did not render"
	);
	expect(text()).not.toContain("Checking this node");
	expect(captionFor("Delete all chats")).toBe("42 chats");
	expect(captionFor("Clear all memory")).toBe("11 memory entries");
	expect(button("Delete all chats").disabled).toBe(false);

	// A failed read (and its one automatic retry) never offers a delete.
	await unmount();
	queryClient.clear();
	await select("local");
	refuse.set("local:GET:/api/data/counts", [
		{ error: "store busy", status: 503 },
		{ error: "store busy", status: 503 },
	]);
	await mount();
	await until(
		() => text().includes("We couldn't load your data."),
		"A refused counts read did not show its recovery state",
		6000
	);
	expect(maybeButton("Delete all chats")?.textContent).toBeUndefined();
	await act(async () => button("Retry").click());
	await until(
		() => maybeButton("Delete all chats") !== undefined,
		"Retry did not reread the counts"
	);
	expect(captionFor("Delete all chats")).toBe("7 chats");
	// An empty category cannot be deleted.
	expect(captionFor("Clear all memory")).toBe("No memory entries");
	expect(button("Clear all memory").disabled).toBe(true);
	expect(
		calls
			.filter((call) => call.owner === "local")
			.map((call) => `${call.path} ${call.status}`)
	).toEqual([
		"/api/data/counts 503",
		"/api/data/counts 503",
		"/api/data/counts 200",
	]);
	expect(writes("local")).toEqual([]);
	expect(writes("remote")).toEqual([]);
}, 15_000);

test("Reset node to a fresh state arms only on the node's name, is refused visibly without touching this device, then wipes the selected remote node through its own Core, clears client state and reloads without restarting local Core", async () => {
	await mount();
	await until(
		() => maybeButton("Delete all chats") !== undefined,
		"Remote counts did not render"
	);
	expect(captionFor("Reset node to a fresh state")).toBe(
		'Fully resets "remote-node" and restarts it'
	);
	await act(async () => button("Reset node").click());
	const confirm = () => button("Reset node", alertDialog());
	expect(alertDialog().textContent).toContain("remote-node");
	expect(confirm().disabled).toBe(true);
	await type(confirmInput(), "local-node");
	expect(confirm().disabled).toBe(true);
	await type(confirmInput(), "  REMOTE-NODE ");
	expect(confirm().disabled).toBe(false);

	refuse.set("remote:POST:/api/node/reset", [
		{
			error:
				"forbidden: resetting a node wipes ALL data on it and is not allowed on a shared (org-bound) node",
			status: 403,
		},
	]);
	await act(async () => confirm().click());
	await until(
		() => errorToast.mock.calls.length === 1,
		"A refused reset did not report"
	);
	expect(errorToast.mock.calls[0]?.[0]).toEqual({
		title: "Could not reset node",
		description:
			"forbidden: resetting a node wipes ALL data on it and is not allowed on a shared (org-bound) node",
	});
	expect(localStorage.getItem("danger-coverage-workspace")).toBe(
		"/proof/workspace"
	);
	expect(reload).not.toHaveBeenCalled();
	expect(confirm().disabled).toBe(false);

	await act(async () => confirm().click());
	await until(() => reload.mock.calls.length === 1, "Reset did not reload");
	expect(successToast.mock.calls[0]?.[0]).toEqual({
		title: "Node reset",
		description: "Restarting to wipe and start fresh…",
	});
	expect(states.remote.resetConfirms).toEqual(["remote-node"]);
	expect(
		calls
			.filter((call) => call.path === "/api/node/reset")
			.map((call) => [call.owner, call.body, call.status])
	).toEqual([
		["remote", { confirm: "remote-node" }, 403],
		["remote", { confirm: "remote-node" }, 200],
	]);
	expect(writes("local")).toEqual([]);
	// A remote node is restarted by its own host; local Core is left alone.
	expect(nativeCalls("stop_ryu_core")).toEqual([]);
	expect(nativeCalls("start_ryu_core")).toEqual([]);
	expect(localStorage.getItem("danger-coverage-workspace")).toBeNull();
	expect(sessionStorage.getItem("danger-coverage-draft")).toBeNull();
});

test("Reset node on the local node restarts the desktop's own Core before reloading, and a Core too old for reset is named as the cause", async () => {
	await select("local");
	await mount();
	await until(
		() => maybeButton("Delete all chats") !== undefined,
		"Local counts did not render"
	);
	await act(async () => button("Reset node").click());
	await type(confirmInput(), "local-node");
	refuse.set("local:POST:/api/node/reset", [
		{ error: "not found", status: 404 },
	]);
	await act(async () => button("Reset node", alertDialog()).click());
	await until(
		() => errorToast.mock.calls.length === 1,
		"An old Core's missing route was not reported"
	);
	expect(String(errorToast.mock.calls[0]?.[0]?.description)).toContain(
		"This node's Core is too old to support resetting"
	);
	expect(nativeCalls("stop_ryu_core")).toEqual([]);

	await act(async () => button("Reset node", alertDialog()).click());
	await until(
		() => reload.mock.calls.length === 1,
		"Local reset did not reload",
		8000
	);
	expect(states.local.resetConfirms).toEqual(["local-node"]);
	expect(
		calls
			.filter((call) => call.path === "/api/node/reset")
			.map((call) => [call.owner, call.status])
	).toEqual([
		["local", 404],
		["local", 200],
	]);
	expect(nativeCalls("stop_ryu_core")).toHaveLength(1);
	expect(nativeCalls("start_ryu_core")).toHaveLength(1);
	const order = ipc.map((entry) => entry.command);
	expect(order.indexOf("stop_ryu_core")).toBeLessThan(
		order.indexOf("start_ryu_core")
	);
	expect(writes("remote")).toEqual([]);
	expect(localStorage.getItem("danger-coverage-workspace")).toBeNull();
}, 15_000);

test("Run deep clean removes each chosen profile in order, offers no machine-wide shadow or ghost clear, keeps choices after a failure, then restarts local Core once and reloads", async () => {
	await select("local");
	await mount();
	await until(
		() => maybeButton("Deep clean…") !== undefined,
		"Deep clean row did not render"
	);
	expect(captionFor("Run deep clean")).toBe(
		"Choose which profiles and how much to remove, then restart into setup"
	);
	await act(async () => button("Deep clean…").click());
	const options = optionsDialog();
	const devProfile = profileChoice(options, "dev");
	expect(devProfile.getAttribute("aria-checked")).toBe("false");
	expect(profileChoice(options, "release").getAttribute("aria-checked")).toBe(
		"true"
	);
	// The user clicks the profile's labelled row.
	const devLabel = options.querySelector('label[for="clean-profile-dev"]');
	if (!(devLabel instanceof HTMLElement)) {
		throw new Error("Missing dev profile label");
	}
	await act(async () => devLabel.click());
	expect(profileChoice(options, "dev").getAttribute("aria-checked")).toBe(
		"true"
	);
	// Shadow and ghost state live inside each profile's data folder, so there is
	// no separate machine-wide clear to offer.
	expect(
		[...options.querySelectorAll('[role="switch"]')].map((element) =>
			element.getAttribute("aria-label")
		)
	).not.toContain("Also clear shadow and ghost");
	await act(async () => button("Continue", optionsDialog()).click());
	const confirmation = alertDialog().textContent ?? "";
	expect(confirmation).toContain("release, dev");
	expect(confirmation).toContain(
		"clear its data folder while keeping downloaded engines and models"
	);
	expect(confirmation).not.toContain("~/.shadow");
	expect(confirmation).not.toContain("shared by every profile");

	failDeepCleanFor("dev");
	await act(async () => button("Remove them", alertDialog()).click());
	await until(
		() => errorToast.mock.calls.length === 1,
		"A failed deep clean did not report"
	);
	expect(errorToast.mock.calls[0]?.[0]).toMatchObject({
		title: "Could not deep clean",
	});
	// The raw native text is logged, never shown; the localized fallback is.
	expect(String(errorToast.mock.calls[0]?.[0]?.description)).toBe(
		"Ryu couldn't finish the deep clean."
	);
	expect(reload).not.toHaveBeenCalled();
	expect(nativeCalls("stop_ryu_core")).toEqual([]);
	// `deep_clean_node` stopped local Core before failing, and nothing else
	// restarts it, so the failure path starts it again for the retry.
	expect(nativeCalls("start_ryu_core")).toHaveLength(1);
	expect(localStorage.getItem("danger-coverage-workspace")).toBe(
		"/proof/workspace"
	);
	// The options stay as chosen for a retry.
	const retryOptions = optionsDialog();
	expect(profileChoice(retryOptions, "dev").getAttribute("aria-checked")).toBe(
		"true"
	);
	expect(
		profileChoice(retryOptions, "release").getAttribute("aria-checked")
	).toBe("true");

	failDeepCleanFor(null);
	await act(async () => button("Continue", retryOptions).click());
	await act(async () => button("Remove them", alertDialog()).click());
	await until(
		() => reload.mock.calls.length === 1,
		"Deep clean did not reload",
		8000
	);
	expect(nativeCalls("deep_clean_node").map((entry) => entry.args)).toEqual([
		{ depth: "state", profile: "release" },
		{ depth: "state", profile: "dev" },
		{ depth: "state", profile: "release" },
		{ depth: "state", profile: "dev" },
	]);
	expect(nativeCalls("stop_ryu_core")).toHaveLength(1);
	expect(nativeCalls("start_ryu_core")).toHaveLength(2);
	expect(successToast.mock.calls[0]?.[0]).toMatchObject({
		title: "Deep clean complete",
	});
	expect(localStorage.getItem("danger-coverage-workspace")).toBeNull();
	// Deep clean is a device operation: no node was asked to delete anything.
	expect(writes("local")).toEqual([]);
	expect(writes("remote")).toEqual([]);
}, 15_000);

test("Run deep clean with a remote node selected cleans this device's profiles but leaves Core restarts to the remote host", async () => {
	await mount();
	await until(
		() => maybeButton("Deep clean…") !== undefined,
		"Deep clean row did not render"
	);
	await act(async () => button("Deep clean…").click());
	await act(async () => button("Continue", optionsDialog()).click());
	const confirmation = alertDialog().textContent ?? "";
	expect(confirmation).toContain(
		"permanently remove the release profile's gateway config folder"
	);
	expect(confirmation).not.toContain("~/.shadow");
	expect(confirmation).not.toContain("shared by every profile");
	await act(async () => button("Remove them", alertDialog()).click());
	await until(
		() => reload.mock.calls.length === 1,
		"Deep clean did not reload"
	);
	expect(nativeCalls("deep_clean_node").map((entry) => entry.args)).toEqual([
		{ depth: "state", profile: "release" },
	]);
	expect(nativeCalls("stop_ryu_core")).toEqual([]);
	expect(writes("remote")).toEqual([]);
});

test("a delete confirmed for one node's counts is never carried out on a node selected while the confirmation was open", async () => {
	await mount();
	await until(
		() => maybeButton("Delete all chats") !== undefined,
		"Remote counts did not render"
	);
	await act(async () => button("Delete all chats").click());
	expect(alertDialog().textContent).toContain("This will delete 42 chats.");
	await type(confirmInput(), "Chats");

	// The selection moves to the local node while the remote's count is shown.
	await select("local");
	await until(
		() => captionFor("Delete all chats") === "7 chats",
		"The tab did not reread the selected node's counts"
	);
	const stillOpen = document.body.querySelector('[role="alertdialog"]');
	const deleteButton = stillOpen ? maybeButton("Delete", stillOpen) : undefined;
	if (deleteButton && !deleteButton.disabled) {
		await act(async () => deleteButton.click());
		await idle();
	}
	// Neither node lost data to a confirmation that described the remote's 42
	// chats: the local node was never asked, and the remote was not either.
	expect(states.local.cleared).toEqual([]);
	expect(states.remote.cleared).toEqual([]);
	expect(writes("local")).toEqual([]);
	expect(writes("remote")).toEqual([]);
	await until(
		() => document.body.querySelector('[role="alertdialog"]') === null,
		"The remote's delete confirmation stayed open for the local node"
	);

	// A fresh confirmation names and clears the selected node's own count.
	await act(async () => button("Delete all chats").click());
	expect(alertDialog().textContent).toContain("This will delete 7 chats.");
	await type(confirmInput(), "chats");
	await act(async () => button("Delete", alertDialog()).click());
	await until(
		() => successToast.mock.calls.length === 1,
		"The local delete did not complete"
	);
	expect(successToast.mock.calls[0]?.[0]).toEqual({
		title: "Deleted",
		description: "7 chats deleted.",
	});
	expect(states.local.cleared).toEqual(["chats"]);
	expect(states.remote.cleared).toEqual([]);
	await until(
		() => captionFor("Delete all chats") === "No chats",
		"Counts were not refreshed after the delete"
	);
});

test("a reset confirmation typed for one node is withdrawn when another node is selected, and reopening names the selected node", async () => {
	await mount();
	await until(
		() => maybeButton("Delete all chats") !== undefined,
		"Remote counts did not render"
	);
	await act(async () => button("Reset node").click());
	await type(confirmInput(), "remote-node");
	expect(button("Reset node", alertDialog()).disabled).toBe(false);
	await select("local");
	await until(
		() => document.body.querySelector('[role="alertdialog"]') === null,
		"The remote's reset confirmation stayed open for the local node"
	);
	expect(captionFor("Reset node to a fresh state")).toBe(
		'Fully resets "local-node" and restarts it'
	);
	await act(async () => button("Reset node").click());
	expect(alertDialog().textContent).toContain("local-node");
	expect(confirmInput().value).toBe("");
	expect(button("Reset node", alertDialog()).disabled).toBe(true);
	expect(calls.filter((call) => call.path === "/api/node/reset")).toEqual([]);
	expect(reload).not.toHaveBeenCalled();
});
