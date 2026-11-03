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
	mount,
	node,
	permissionElement,
	releaseAndConsume,
	selectNode,
	until,
} from "./ResourcePermissions.authority.native-http.test-support.tsx";
import {
	assertForeignRead,
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
	drain,
	type EditedResource,
	editedRows,
	heldBodies,
	live,
	type Overwrite,
	otherResourceId,
	otherResourcePath,
	type Records,
	readPhysical,
	resourceId,
	resourcePath,
	spaceResourceKey,
	spaceResourcePath,
	spaceRows,
} from "./ResourcePermissions.authority.native-http-store.test-support.tsx";

registerResourcePermissionsHooks();

test("an acknowledged same-authority Save cannot erase a newer pending tri-state draft before its next whole-set save", async () => {
	await selectNode(node("b"));
	const start = live.nextId;
	await mount();
	await completeRead("b", "a", start, "Current role");
	const original = await readPhysical();
	await editPermission("Edit items", "Allow");
	const savedRows = editedRows();
	assertRenderedRows(savedRows);
	live.holdPlan = {
		owner: "b",
		method: "PUT",
		bearer: credentials("b").token,
		delegation: credentials("b").userJwt,
		status: 200,
	};
	await act(async () => button("Save").click());
	await until(
		() => heldBodies.length === 1 && bodyStarts.includes(heldBodies[0]!.id),
		"Real same-authority Save did not await its held acknowledgment body"
	);
	const held = heldBodies[0]!;
	const write = calls.find((call) => call.id === held.id)!;
	expect(write).toMatchObject({
		owner: "b",
		method: "PUT",
		url: `${node("b").url}${resourcePath}`,
		bearer: "Bearer permissions-b-bearer-a",
		delegation: "permissions-b-jwt-a",
		body: { overwrites: savedRows },
		status: 200,
	});
	expect(acknowledged(write)).toBeUndefined();
	const expectedBeforeNextSave: Records = {
		...original,
		b: { ...original.b, [resourceId]: savedRows },
	};
	// The real peer has already committed the first write, even though its
	// native SDK acknowledgment remains unread. No rollback is invented here.
	expect(await readPhysical()).toEqual(expectedBeforeNextSave);
	expect(button("Saving…").disabled).toBe(true);
	const newerControl = button("Deny", permissionElement(0, "View items"));
	expect(newerControl.disabled).toBe(false);
	await editPermission("View items", "Deny");
	const newerRows: Overwrite[] = [
		{
			target_type: "role",
			target_id: "role-current",
			allow: ["space.edit"],
			deny: ["space.view"],
		},
		{
			target_type: "team",
			target_id: "team-retained",
			allow: ["space.view"],
			deny: [],
		},
	];
	assertRenderedRows(newerRows);
	const draft = draftInput();
	newerControl.focus();
	expect(document.activeElement).toBe(newerControl);
	const beforeReceipt = calls.map((call) => call.id);
	await releaseAndConsume(held);
	expect(acknowledged(write)).toEqual({
		id: held.id,
		status: 200,
		text: JSON.stringify({ ok: true }),
	});
	expect(button("Save").disabled).toBe(false);
	assertRenderedRows(newerRows);
	expect(button("Deny", permissionElement(0, "View items"))).toBe(newerControl);
	expect(document.activeElement).toBe(newerControl);
	expect(draftInput()).toBe(draft);
	expect(draft.value).toBe("Unsent permissions draft");
	expect(localStorage.getItem("permissions-unrelated")).toBe("preserved");
	expect(localStorage.getItem("ryu:timezone")).toBe("Asia/Tokyo");
	expect(calls.map((call) => call.id)).toEqual(beforeReceipt);
	expect(await readPhysical()).toEqual(expectedBeforeNextSave);
	await assertForeignRead(expectedBeforeNextSave);
	await saveCurrent("b", "a", newerRows);
	const expected: Records = {
		...original,
		b: { ...original.b, [resourceId]: newerRows },
	};
	expect(await readPhysical()).toEqual(expected);
	await assertFreshRenderer("b", "a", expected);
	await assertRetiredConsumer(expected);
});

test("switching the edited resource kind or ID retires its held save refusal and read, and saves only the current resource's draft", async () => {
	await selectNode(node("b"));
	let start = live.nextId;
	await mount();
	await completeRead("b", "a", start, "Current role");
	const original = await readPhysical();
	const resourceRead = async (path: string, after: number, label: string) => {
		await until(
			() =>
				["/api/acl/vocabulary", "/api/acl/principals", path].every((route) =>
					calls.some(
						(call) =>
							call.id > after &&
							call.owner === "b" &&
							call.method === "GET" &&
							call.url === `${node("b").url}${route}` &&
							call.bearer === "Bearer permissions-b-bearer-a" &&
							call.delegation === "permissions-b-jwt-a" &&
							acknowledged(call)?.status === 200
					)
				),
			`Actual editor did not consume all three reads for ${path}`
		);
		await until(
			() =>
				editor().textContent?.includes(label) === true &&
				!editor().textContent?.includes("Loading permissions"),
			`Actual editor did not render acknowledged rows for ${path}`
		);
	};
	const switchResource = (next: EditedResource) =>
		act(async () => {
			if (!live.selectResource) {
				throw new Error("Mounted resource host is not registered");
			}
			live.selectResource(next);
		});
	// 1. An agent draft is refused by the node, but its 503 reply is still held.
	await editPermission("Edit items", "Allow");
	assertRenderedRows(editedRows());
	live.holdPlan = {
		owner: "b",
		method: "PUT",
		bearer: credentials("b").token,
		delegation: credentials("b").userJwt,
		status: 503,
	};
	await act(async () => button("Save").click());
	await until(
		() => heldBodies.length === 1 && bodyStarts.includes(heldBodies[0]!.id),
		"Real agent Save refusal did not await its held body"
	);
	const heldRefusal = heldBodies[0]!;
	expect(calls.find((call) => call.id === heldRefusal.id)).toMatchObject({
		owner: "b",
		method: "PUT",
		url: `${node("b").url}${resourcePath}`,
		bearer: "Bearer permissions-b-bearer-a",
		delegation: "permissions-b-jwt-a",
		body: { overwrites: editedRows() },
		status: 503,
	});
	expect(await readPhysical()).toEqual(original);
	// 2. Same kind, different ID: its actual read is held mid-body.
	live.holdPlan = {
		owner: "b",
		method: "GET",
		path: otherResourcePath,
		bearer: credentials("b").token,
		delegation: credentials("b").userJwt,
		status: 200,
	};
	await switchResource({ kind: "agent", id: otherResourceId });
	await until(
		() => heldBodies.length === 2 && bodyStarts.includes(heldBodies[1]!.id),
		"Real other-ID read did not await its held body"
	);
	const heldRead = heldBodies[1]!;
	expect(editor().textContent).toContain("Loading permissions");
	expect(calls.find((call) => call.id === heldRead.id)).toMatchObject({
		owner: "b",
		method: "GET",
		url: `${node("b").url}${otherResourcePath}`,
		rawBody: "",
		status: 200,
	});
	// 3. Same ID, different kind: the editor reads and drafts the space record.
	start = live.nextId;
	await switchResource({ kind: "space", id: resourceId });
	await resourceRead(spaceResourcePath, start, "Source role");
	assertRenderedRows(spaceRows());
	expect(editor().textContent).toContain("Exceptions for this space.");
	expect(button("Save").disabled).toBe(true);
	await editPermission("Edit items", "Deny");
	const spaceDraft: Overwrite[] = [
		{
			target_type: "role",
			target_id: "role-source",
			allow: ["space.view"],
			deny: ["space.edit"],
		},
	];
	assertRenderedRows(spaceDraft);
	const draft = draftInput();
	draft.focus();
	const beforeReceipts = calls.map((call) => call.id);
	// 4. Both retired replies are genuinely decoded after the switch. The
	// refusal is consumed first while the other-ID read is still held, so the
	// shared drain only runs once no held body remains.
	await act(async () => {
		heldRefusal.release();
	});
	await until(
		() =>
			acknowledged(calls.find((call) => call.id === heldRefusal.id)!) !==
			undefined,
		"Retired refusal body was not decoded"
	);
	await releaseAndConsume(heldRead);
	expect(heldRefusal.released).toBe(true);
	expect(heldRefusal.cancelled).toBeNull();
	expect(
		acknowledged(calls.find((call) => call.id === heldRefusal.id)!)?.text
	).toBe(JSON.stringify({ error: "Owned ACL peer unavailable" }));
	expect(
		acknowledged(calls.find((call) => call.id === heldRead.id)!)?.text
	).toBe(
		JSON.stringify({
			kind: "agent",
			id: otherResourceId,
			overwrites: original.b[otherResourceId],
		})
	);
	await act(async () => {
		await assertForeignRead(original);
		await drain();
	});
	expect(
		calls.filter(
			(call) => call.id > beforeReceipts.at(-1)! && call.owner !== "foreign"
		)
	).toEqual([]);
	expect(document.body.textContent).not.toContain("Could not save permissions");
	expect(editor().querySelector('[aria-label="Person identifier"]')).toBeNull();
	expect(editor().textContent).toContain("Exceptions for this space.");
	assertRenderedRows(spaceDraft);
	expect(button("Save").disabled).toBe(false);
	expect(await readPhysical()).toEqual(original);
	assertRetainedDraft(draft);
	// 5. The next Save writes only the current kind/ID with the current draft.
	start = live.nextId;
	await act(async () => button("Save").click());
	await until(
		() =>
			calls.some(
				(call) =>
					call.id > start &&
					call.method === "PUT" &&
					acknowledged(call)?.status === 200
			),
		"Actual space Save did not consume its native acknowledgment"
	);
	const writes = calls.filter(
		(call) => call.id > start && call.method === "PUT"
	);
	expect(writes).toHaveLength(1);
	expect(writes[0]).toMatchObject({
		owner: "b",
		url: `${node("b").url}${spaceResourcePath}`,
		bearer: "Bearer permissions-b-bearer-a",
		delegation: "permissions-b-jwt-a",
		body: { overwrites: spaceDraft },
		status: 200,
	});
	await resourceRead(spaceResourcePath, writes[0]!.id, "Source role");
	await until(
		() =>
			document.body.textContent?.includes("Permissions saved") === true &&
			button("Save").disabled,
		"Real space Save did not acknowledge persisted clean state and success Toaster"
	);
	await act(async () => {
		await drain();
	});
	assertRenderedRows(spaceDraft);
	const expected: Records = {
		...original,
		b: { ...original.b, [spaceResourceKey]: spaceDraft },
	};
	expect(await readPhysical()).toEqual(expected);
	// 6. Returning to the agent ID reads its stored rows; the retired refused
	// draft was never written and is not resurrected.
	start = live.nextId;
	await switchResource({ kind: "agent", id: resourceId });
	await resourceRead(resourcePath, start, "Current role");
	assertRenderedRows(currentRows());
	expect(button("Save").disabled).toBe(true);
	expect(editor().textContent).toContain("Exceptions for this agent.");
	expect(await readPhysical()).toEqual(expected);
	await assertFreshRenderer("b", "a", expected);
	await assertRetiredConsumer(expected);
}, 30_000);
