import { expect, test } from "bun:test";
import {
	act,
	autoTopupWrites,
	BUDGET_KEY,
	blur,
	budget,
	calls,
	cap,
	click,
	ENTITLEMENT_MIRROR_PATHS,
	enterCode,
	errorTitles,
	GOOD_CODE,
	harness,
	input,
	mount,
	nodes,
	northRecharge,
	rechargeOn,
	rechargeSwitch,
	refusals,
	selectNode,
	settle,
	settledRecharge,
	switchWorkspace,
	text,
	type,
	unmount,
	until,
} from "./BillingTab.native-http.harness.ts";

// Spend controls on the shipping Billing tab: automatic recharge per workspace
// and the per-node default sandbox run budget. The harness is shared with
// `BillingTab.lifetime.native-http.test.tsx`.

test("Automatic recharge and its 0 = no limit cap belong to the workspace: a switch never carries the previous workspace's ON switch or cap, and enabling it there saves that workspace's own record after the billing code", async () => {
	await mount();
	await until(
		() => settledRecharge() && rechargeOn(),
		"north recharge not shown"
	);
	expect(cap().value).toBe("100");
	expect(input("#autotopup-threshold").value).toBe("7");
	expect(input("#autotopup-amount").value).toBe("20");

	await switchWorkspace("org-south");
	await until(
		() =>
			settledRecharge() &&
			!rechargeOn() &&
			calls.some(
				(call) =>
					call.org === "org-south" && call.path === "/api/credits/autotopup"
			),
		"south recharge not loaded"
	);
	await settle(50);
	expect(rechargeOn()).toBe(false);
	expect(cap().value).toBe("0");
	expect(input("#autotopup-threshold").value).toBe("5");
	expect(input("#autotopup-amount").value).toBe("10");
	expect(autoTopupWrites()).toEqual([]);

	// A negative limit means no limit, never a negative cap.
	await type(cap(), "-25");
	await click(rechargeSwitch());
	await enterCode("111111");
	await until(
		() => text().includes("That code didn't work."),
		"wrong code accepted"
	);
	expect(autoTopupWrites()).toEqual([]);
	await enterCode(GOOD_CODE);
	await until(() => autoTopupWrites().length === 1, "south record not saved");
	expect(autoTopupWrites()).toEqual([
		{
			body: {
				amountCents: 1000,
				enabled: true,
				monthlyCapCents: 0,
				thresholdCents: 500,
			},
			org: "org-south",
			status: 200,
		},
	]);
	await until(() => rechargeOn(), "switch did not stay on");
	expect(harness.autoTopups["org-north"]).toEqual(northRecharge());

	// With the record on, a new limit is saved on blur.
	await type(cap(), "250");
	await blur(cap());
	await until(() => autoTopupWrites().length === 2, "limit not saved");
	expect(harness.autoTopups["org-south"]?.monthlyCapCents).toBe(25_000);
	expect(harness.autoTopups["org-north"]?.monthlyCapCents).toBe(10_000);
});

test("Automatic recharge rolls back when the save is refused, and a disabled card keeps edits local", async () => {
	harness.grants = 1;
	harness.autoTopups = {};
	await mount();
	await until(() => settledRecharge(), "recharge card not ready");
	await type(cap(), "80");
	await blur(cap());
	await settle(50);
	expect(autoTopupWrites()).toEqual([]);

	refusals.set("PUT /api/credits/autotopup", 503);
	await click(rechargeSwitch());
	await until(
		() => autoTopupWrites().length === 1 && errorTitles().length > 0,
		"refusal not surfaced"
	);
	await until(() => !rechargeOn(), "switch did not roll back");
	expect(harness.autoTopups["org-north"]).toBeUndefined();

	await click(rechargeSwitch());
	await until(() => autoTopupWrites().length === 2, "retry not sent");
	expect(autoTopupWrites()[1]?.body).toEqual({
		amountCents: 1000,
		enabled: true,
		monthlyCapCents: 8000,
		thresholdCents: 500,
	});
	await until(() => rechargeOn(), "switch not on after retry");
	expect(harness.autoTopups["org-north"]?.enabled).toBe(true);
});

test("Default sandbox run budget is read from and written to the selected node in micro-USD, survives a remount, and follows a node switch", async () => {
	nodes.preferences.north?.set(BUDGET_KEY, "15000000");
	nodes.preferences.south?.set(BUDGET_KEY, "3000000");
	await mount();
	await until(() => budget().value === "15", "north budget not read");

	await type(budget(), "12.345678");
	await blur(budget());
	await until(
		() => nodes.preferences.north?.get(BUDGET_KEY) === "12345678",
		"budget not written"
	);
	expect(budget().value).toBe("12.345678");
	expect(nodes.preferences.south?.get(BUDGET_KEY)).toBe("3000000");

	// Unedited blur writes nothing. The entitlement provider mirrors its verdict
	// to the selected node once per mount, after its own control-plane reads, so
	// let that best-effort push land first instead of counting it as a write.
	await until(
		() =>
			ENTITLEMENT_MIRROR_PATHS.every((path) =>
				nodes.calls.some(
					(call) =>
						call.node === "north" && call.method === "PUT" && call.path === path
				)
			),
		"entitlement mirror not pushed"
	);
	const writes = nodes.calls.filter((call) => call.method === "PUT").length;
	await blur(budget());
	await settle(50);
	expect(nodes.calls.filter((call) => call.method === "PUT")).toHaveLength(
		writes
	);

	await unmount();
	await mount();
	await until(() => budget().value === "12.345678", "budget not read back");

	// The selected node changes underneath the open tab.
	await selectNode("south");
	await until(() => budget().value === "3", "south budget never shown");
	await type(budget(), "4");
	await blur(budget());
	await until(
		() => nodes.preferences.south?.get(BUDGET_KEY) === "4000000",
		"south budget not written"
	);
	expect(nodes.preferences.north?.get(BUDGET_KEY)).toBe("12345678");
});

test("Default sandbox run budget: an unsaved edit on one node is cleared by a node switch whose read is refused, so a blur saves nothing onto the new node", async () => {
	nodes.preferences.north?.set(BUDGET_KEY, "15000000");
	nodes.preferences.south?.set(BUDGET_KEY, "3000000");
	await mount();
	await until(() => budget().value === "15", "north budget not read");

	// Typed for north, never saved: the field is dirty and still focused.
	await act(async () => budget().focus());
	await type(budget(), "9");
	expect(budget().value).toBe("9");

	nodes.refuseNext("south", "GET", `/api/preferences/${BUDGET_KEY}`, 503);
	await selectNode("south");
	await until(
		() =>
			nodes.calls.some(
				(call) =>
					call.node === "south" &&
					call.method === "GET" &&
					call.path === `/api/preferences/${BUDGET_KEY}` &&
					call.status === 503
			),
		"south budget read was not refused"
	);
	await settle(50);
	// Neither north's unsaved 9 nor north's saved 15 is shown for south.
	expect(budget().value).toBe("0");

	// The cleared field is not dirty, so leaving it writes to no node.
	await blur(budget());
	await settle(100);
	expect(
		nodes.calls.filter(
			(call) =>
				call.method === "PUT" && call.path === `/api/preferences/${BUDGET_KEY}`
		)
	).toEqual([]);
	expect(nodes.preferences.south?.get(BUDGET_KEY)).toBe("3000000");
	expect(nodes.preferences.north?.get(BUDGET_KEY)).toBe("15000000");
	expect(errorTitles()).toEqual([]);
});

test("Default sandbox run budget: a save still in flight for the previous node does not mark the new node's edit as saved", async () => {
	nodes.preferences.north?.set(BUDGET_KEY, "15000000");
	nodes.preferences.south?.set(BUDGET_KEY, "3000000");
	await mount();
	await until(() => budget().value === "15", "north budget not read");

	const releaseNorth = nodes.hold(
		"north",
		"PUT",
		`/api/preferences/${BUDGET_KEY}`
	);
	await act(async () => budget().focus());
	await type(budget(), "12");
	await blur(budget());
	await until(
		() =>
			nodes.calls.some(
				(call) =>
					call.node === "north" &&
					call.method === "PUT" &&
					call.path === `/api/preferences/${BUDGET_KEY}`
			),
		"north save not sent"
	);

	await selectNode("south");
	await until(() => budget().value === "3", "south budget never shown");
	await act(async () => budget().focus());
	await type(budget(), "4");
	// North acknowledges its save while south's edit is still unsaved.
	releaseNorth();
	await until(
		() => nodes.preferences.north?.get(BUDGET_KEY) === "12000000",
		"north save not acknowledged"
	);
	await settle(50);
	await blur(budget());
	await until(
		() => nodes.preferences.south?.get(BUDGET_KEY) === "4000000",
		"south edit was dropped as already saved"
	);
	expect(nodes.preferences.north?.get(BUDGET_KEY)).toBe("12000000");
});
