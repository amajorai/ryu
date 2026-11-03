// biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared native-HTTP ledger and conservation helpers run only inside this file's real bun:test cases and hooks.
import { expect, test } from "bun:test";
import { act } from "react";
import {
	acknowledged,
	assertRenderedRows,
	button,
	completeRead,
	draftInput,
	editor,
	editPermission,
	externalWrite,
	mount,
	node,
	releaseAndConsume,
	selectNode,
	until,
} from "./ResourcePermissions.authority.native-http.test-support.tsx";
// The loopback peer the support modules start; imported here so its setup
// is visibly part of this suite, in the order the support chain runs it.
import "./ResourcePermissions.authority.native-http-peer.test-support.tsx";
import {
	assertFreshRenderer,
	assertRetainedDraft,
	assertRetiredConsumer,
	registerResourcePermissionsHooks,
	saveCurrent,
} from "./ResourcePermissions.authority.native-http-hooks.test-support.tsx";
import {
	bodyStarts,
	calls,
	credentials,
	currentRows,
	editedRows,
	heldBodies,
	live,
	type Overwrite,
	type Records,
	readPhysical,
	resourceId,
	resourcePath,
} from "./ResourcePermissions.authority.native-http-store.test-support.tsx";

registerResourcePermissionsHooks();

test("a late prior-node ACL read cannot replace current targets or poison the next acknowledged whole-set save", async () => {
	const original = await readPhysical();
	live.holdPlan = {
		owner: "a",
		method: "GET",
		bearer: credentials("a").token,
		delegation: credentials("a").userJwt,
		status: 200,
	};
	await mount();
	await until(
		() => heldBodies.length === 1 && bodyStarts.includes(heldBodies[0]!.id),
		"Real A resource decoder did not await its held body"
	);
	const held = heldBodies[0]!;
	const start = live.nextId;
	await selectNode(node("b"));
	await completeRead("b", "a", start, "Current role");
	const draft = draftInput();
	draft.focus();
	await releaseAndConsume(held);
	expect(calls.find((call) => call.id === held.id)).toMatchObject({
		owner: "a",
		method: "GET",
		url: `${node("a").url}${resourcePath}`,
		bearer: "Bearer permissions-a-bearer-a",
		delegation: "permissions-a-jwt-a",
		rawBody: "",
		status: 200,
	});
	expect(acknowledged(calls.find((call) => call.id === held.id)!)?.text).toBe(
		JSON.stringify({
			kind: "agent",
			id: resourceId,
			overwrites: original.a[resourceId],
		})
	);
	expect(editor().textContent).toContain("Current role");
	expect(editor().textContent).toContain("Retained team");
	expect(editor().textContent).not.toContain("Source role");
	expect(editor().querySelectorAll("li")).toHaveLength(2);
	assertRenderedRows(currentRows());
	expect(await readPhysical()).toEqual(original);
	assertRetainedDraft(draft);
	await editPermission("Edit items", "Allow");
	draft.focus();
	await saveCurrent("b", "a", editedRows());
	const expected: Records = {
		...original,
		b: { ...original.b, [resourceId]: editedRows() },
	};
	expect(await readPhysical()).toEqual(expected);
	await assertFreshRenderer("b", "a", expected);
	await assertRetiredConsumer(expected);
});

test("a retired Bearer-scope ACL save refusal cannot publish a current error or discard the next retry draft", async () => {
	const start = live.nextId;
	await mount();
	await completeRead("a", "a", start, "Source role");
	const original = await readPhysical();
	await editPermission("View items", "Allow");
	live.holdPlan = {
		owner: "a",
		method: "PUT",
		bearer: credentials("a").token,
		delegation: credentials("a").userJwt,
		status: 503,
	};
	await act(async () => button("Save").click());
	await until(
		() => heldBodies.length === 1 && bodyStarts.includes(heldBodies[0]!.id),
		"Real old Save refusal decoder did not await its body"
	);
	const held = heldBodies[0]!;
	expect(await readPhysical()).toEqual(original);
	await externalWrite("a", "bearer", currentRows());
	const expectedBeforeRetry: Records = {
		...original,
		a: { ...original.a, [resourceId]: currentRows() },
	};
	expect(await readPhysical()).toEqual(expectedBeforeRetry);
	const rotatedStart = live.nextId;
	await selectNode(node("a", "bearer"));
	await completeRead("a", "bearer", rotatedStart, "Current role");
	await editPermission("Edit items", "Allow");
	const draft = draftInput();
	draft.focus();
	await releaseAndConsume(held);
	const refusal = calls.find((call) => call.id === held.id)!;
	expect(refusal).toMatchObject({
		owner: "a",
		method: "PUT",
		status: 503,
		bearer: "Bearer permissions-a-bearer-a",
		delegation: "permissions-a-jwt-a",
		body: {
			overwrites: [
				{
					target_type: "role",
					target_id: "role-source",
					allow: ["space.edit", "space.view"],
					deny: [],
				},
			],
		},
	});
	expect(acknowledged(refusal)?.text).toBe(
		JSON.stringify({ error: "Owned ACL peer unavailable" })
	);
	expect(editor().textContent).toContain("Current role");
	expect(button("Save").disabled).toBe(false);
	assertRenderedRows(editedRows());
	expect(document.body.textContent).not.toContain("Could not save permissions");
	expect(await readPhysical()).toEqual(expectedBeforeRetry);
	assertRetainedDraft(draft);
	await saveCurrent("a", "bearer", editedRows());
	const expected: Records = {
		...original,
		a: { ...original.a, [resourceId]: editedRows() },
	};
	expect(await readPhysical()).toEqual(expected);
	await assertFreshRenderer("a", "bearer", expected);
	await assertRetiredConsumer(expected);
});

test("a held successful ACL save stays retired after JWT A-B-A and cannot refresh away a newer unsaved whole-set edit", async () => {
	const start = live.nextId;
	await mount();
	await completeRead("a", "a", start, "Source role");
	const original = await readPhysical();
	await editPermission("View items", "Allow");
	live.holdPlan = {
		owner: "a",
		method: "PUT",
		bearer: credentials("a").token,
		delegation: credentials("a").userJwt,
		status: 200,
	};
	await act(async () => button("Save").click());
	await until(
		() => heldBodies.length === 1 && bodyStarts.includes(heldBodies[0]!.id),
		"Real successful old Save did not wait for acknowledgment bytes"
	);
	const held = heldBodies[0]!;
	const savedOriginalRows: Overwrite[] = [
		{
			target_type: "role",
			target_id: "role-source",
			allow: ["space.edit", "space.view"],
			deny: [],
		},
	];
	expect(calls.find((call) => call.id === held.id)).toMatchObject({
		owner: "a",
		method: "PUT",
		bearer: "Bearer permissions-a-bearer-a",
		delegation: "permissions-a-jwt-a",
		body: { overwrites: savedOriginalRows },
		status: 200,
	});
	expect(await readPhysical()).toEqual({
		...original,
		a: { ...original.a, [resourceId]: savedOriginalRows },
	});
	await externalWrite("a", "jwt", currentRows());
	const expectedBeforeRetry: Records = {
		...original,
		a: { ...original.a, [resourceId]: currentRows() },
	};
	let rotatedStart = live.nextId;
	await selectNode(node("a", "jwt"));
	await completeRead("a", "jwt", rotatedStart, "Current role");
	rotatedStart = live.nextId;
	await selectNode(node("a"));
	await completeRead("a", "a", rotatedStart, "Current role");
	await editPermission("Edit items", "Allow");
	const draft = draftInput();
	draft.focus();
	const beforeReceipt = calls.map((call) => call.id);
	await releaseAndConsume(held);
	expect(acknowledged(calls.find((call) => call.id === held.id)!)).toEqual({
		id: held.id,
		status: 200,
		text: JSON.stringify({ ok: true }),
	});
	expect(editor().textContent).toContain("Current role");
	expect(editor().textContent).toContain("Retained team");
	expect(button("Save").disabled).toBe(false);
	assertRenderedRows(editedRows());
	expect(document.body.textContent).not.toContain("Permissions saved");
	expect(calls.map((call) => call.id)).toEqual(beforeReceipt);
	expect(await readPhysical()).toEqual(expectedBeforeRetry);
	assertRetainedDraft(draft);
	await saveCurrent("a", "a", editedRows());
	const expected: Records = {
		...original,
		a: { ...original.a, [resourceId]: editedRows() },
	};
	expect(await readPhysical()).toEqual(expected);
	await assertFreshRenderer("a", "a", expected);
	await assertRetiredConsumer(expected);
});
