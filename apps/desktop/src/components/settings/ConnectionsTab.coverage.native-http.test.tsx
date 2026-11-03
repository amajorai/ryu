import { expect, test } from "bun:test";
import {
	bootNodeStore,
	button,
	click,
	currentClientId,
	dialogTitled,
	flush,
	harness,
	ipcCalls,
	LOCAL_FALLBACK,
	LOCAL_NODE_TOKEN,
	maybeButton,
	mount,
	openRemoteDialog,
	openTab,
	presenceRequests,
	registerConnectionsCoverageHooks,
	remoteDialog,
	remoteFields,
	rowCaption,
	settingsRow,
	settingsRowsWith,
	settle,
	syncPlanCapState,
	text,
	typeInto,
	unmount,
} from "./ConnectionsTab.coverage.test-support.tsx";

// Control-level coverage for the shipping ConnectionsTab: remote nodes through
// the native nodes.json bridge, the plan cap, and connected-device presence.
// The harness (loopback Core and control plane, IPC bridge) is shared with the
// SSH suite in ConnectionsTab.coverage.test-support.tsx.
registerConnectionsCoverageHooks();

test("remote node fields gate Add, send a trimmed native payload, survive a refusal for retry, and persist through a store reload", async () => {
	await mount();
	await openTab("Control other devices", "Remote nodes");
	expect(text()).toContain("No remote nodes yet");
	await openRemoteDialog();

	let fields = remoteFields();
	expect(fields.name.value).toBe("");
	expect(fields.url.value).toBe("");
	expect(fields.token.value).toBe("");
	expect(fields.token.type).toBe("password");
	expect(fields.submit.disabled).toBe(true);
	await typeInto(fields.name, "  build-node  ");
	expect(remoteFields().submit.disabled).toBe(true);
	await typeInto(fields.url, "   ");
	expect(remoteFields().submit.disabled).toBe(true);
	await typeInto(fields.url, "  https://build.example.test:7980  ");
	await typeInto(fields.token, "  build-node-secret  ");
	expect(remoteFields().submit.disabled).toBe(false);

	harness.armedIpcFailure = "add_node";
	await click(remoteFields().submit);
	await settle(
		() => remoteDialog().querySelector('[role="alert"]') !== null,
		"native refusal",
		text
	);
	expect(remoteDialog().querySelector('[role="alert"]')?.textContent).toBe(
		"Native refused add_node"
	);
	fields = remoteFields();
	expect(fields.name.value).toBe("  build-node  ");
	expect(fields.url.value).toBe("  https://build.example.test:7980  ");
	expect(fields.token.value).toBe("  build-node-secret  ");
	expect(harness.nativeNodes.map((candidate) => candidate.name)).toEqual([
		"local",
	]);

	await click(remoteFields().submit);
	await settle(
		() => dialogTitled("Add remote node") === null,
		"dialog closed",
		text
	);
	await settle(
		() => settingsRow("build-node", harness.container) !== null,
		"node row",
		text
	);
	expect(text()).toContain("Remote node added");
	expect(rowCaption("build-node", harness.container)).toBe(
		"https://build.example.test:7980"
	);
	const payload = {
		name: "build-node",
		token: "build-node-secret",
		url: "https://build.example.test:7980",
	};
	expect(ipcCalls("add_node")).toEqual([payload, payload]);

	// Reopening starts from empty fields; a blank token is sent as null.
	await openRemoteDialog();
	fields = remoteFields();
	expect([fields.name.value, fields.url.value, fields.token.value]).toEqual([
		"",
		"",
		"",
	]);
	await typeInto(fields.name, "lab-node");
	await typeInto(fields.url, "http://lab.example.test:7980");
	await typeInto(fields.token, "   ");
	await click(remoteFields().submit);
	await settle(
		() => settingsRow("lab-node", harness.container) !== null,
		"second node",
		text
	);
	expect(ipcCalls("add_node").at(-1)).toEqual({
		name: "lab-node",
		token: null,
		url: "http://lab.example.test:7980",
	});

	// Independent reload: drop the in-memory list and rebuild it from nodes.json.
	await unmount();
	await bootNodeStore();
	await mount();
	await openTab("Control other devices", "Remote nodes");
	expect(settingsRow("build-node", harness.container)).not.toBeNull();
	expect(settingsRow("lab-node", harness.container)).not.toBeNull();
	expect(harness.nativeNodes).toEqual([
		{ name: "local", token: null, url: LOCAL_FALLBACK.url },
		payload,
		{ name: "lab-node", token: null, url: "http://lab.example.test:7980" },
	]);
});

test("a signed-in free plan refuses a second remote node before any native write and asks for an upgrade", async () => {
	harness.nativeNodes = [
		{ name: "local", token: null, url: LOCAL_FALLBACK.url },
		{
			name: "First remote",
			token: null,
			url: "https://first.example.test:7980",
		},
	];
	await bootNodeStore();
	let upgradeRequests = 0;
	// Signed in with no purchased plan: the free tier's one-remote-node cap.
	syncPlanCapState(null, () => {
		upgradeRequests += 1;
	});
	await mount();
	await openTab("Control other devices", "Remote nodes");
	await openRemoteDialog();
	const fields = remoteFields();
	await typeInto(fields.name, "second-remote");
	await typeInto(fields.url, "https://second.example.test:7980");
	await click(remoteFields().submit);
	await settle(
		() => remoteDialog().querySelector('[role="alert"]') !== null,
		"plan refusal",
		text
	);
	expect(remoteDialog().querySelector('[role="alert"]')?.textContent).toBe(
		"Plan limit reached for maxRemoteNodes (1)."
	);
	expect(upgradeRequests).toBe(1);
	expect(ipcCalls("add_node")).toEqual([]);
	expect(harness.nativeNodes.map((candidate) => candidate.name)).toEqual([
		"local",
		"First remote",
	]);
	expect(remoteFields().name.value).toBe("second-remote");
});

test("connected-device presence recovers through Retry and marks only this client as This device", async () => {
	harness.presenceStatus = 503;
	await mount();
	await settle(
		() =>
			text().includes("Connected-device presence is unavailable on this node."),
		"presence error",
		text
	);
	expect(text()).not.toContain("No other devices have connected recently.");
	const now = Math.floor(Date.now() / 1000);
	harness.presenceStatus = 200;
	harness.presence = [
		{
			client_id: currentClientId(),
			client_label: "Desktop",
			first_seen: now - 60,
			last_seen: now,
			surface: "desktop",
			user_id: null,
			user_name: "Studio desktop",
		},
		{
			client_id: "peer-phone",
			client_label: "Pixel phone",
			first_seen: now - 40,
			last_seen: now - 5,
			surface: "mobile",
			user_id: null,
			user_name: null,
		},
	];
	await click(button("Retry connected device presence", harness.container));
	await settle(
		() => !text().includes("Connected-device presence is unavailable"),
		"presence recovered",
		text
	);
	await settle(
		() =>
			maybeButton("Retry connected device presence", harness.container) ===
				null &&
			settingsRowsWith("Studio desktop").length === 1 &&
			settingsRowsWith("Pixel phone").length === 1,
		"presence rows",
		text
	);
	const rows = [
		...harness.container.querySelectorAll<HTMLElement>('[data-slot="item"]'),
	];
	const self = rows.find((row) => row.textContent?.includes("Studio desktop"));
	const peer = rows.find((row) => row.textContent?.includes("Pixel phone"));
	expect(self?.textContent).toContain("This device");
	expect(peer?.textContent).not.toContain("This device");
	expect(presenceRequests).toHaveLength(2);
	for (const sent of presenceRequests) {
		expect(sent).toEqual({
			authorization: `Bearer ${LOCAL_NODE_TOKEN}`,
			client: currentClientId(),
		});
	}
	await flush();
});
