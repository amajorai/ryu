import { expect, test } from "bun:test";
import { observeChatPresence } from "./chat-presence-observation.ts";

test("native chat and Core join packets retain the whole raw value and nullable fields", () => {
	const raw = {
		member_id: "peer",
		name: " Ada ",
		typing: true,
		future: { cursor: [1, 2] },
	};
	const result = observeChatPresence(raw, "delta");
	expect(result).toEqual({
		kind: "upsert",
		memberId: "peer",
		name: " Ada ",
		typing: true,
		raw,
	});
	expect(result?.raw).toBe(raw);
	expect(
		observeChatPresence({ type: "presence_join", member_id: "peer" }, "roster")
	).toMatchObject({
		kind: "upsert",
		memberId: "peer",
		name: undefined,
		typing: undefined,
	});
	expect(
		observeChatPresence(
			{ member_id: "peer", name: null, typing: null },
			"delta"
		)
	).toMatchObject({ kind: "upsert", name: null, typing: null });
});

test("all defined strings survive observation including empty and inherited-looking identifiers", () => {
	for (const memberId of [
		"",
		"__proto__",
		"constructor",
		"toString",
		" peer ",
	]) {
		expect(
			observeChatPresence(
				{ member_id: memberId, name: "", typing: false },
				"delta"
			)
		).toMatchObject({ kind: "upsert", memberId, name: "", typing: false });
	}
});

test("malformed peer fields cannot enter the name trim or typing rendering state", () => {
	for (const raw of [
		{ member_id: 1, name: "Ada", typing: true },
		{ member_id: "peer", name: {}, typing: true },
		{ member_id: "peer", name: ["Ada"], typing: true },
		{ member_id: "peer", name: 1, typing: true },
		{ member_id: "peer", name: "Ada", typing: "false" },
		{ member_id: "peer", name: "Ada", typing: 1 },
	]) {
		expect(observeChatPresence(raw, "delta")).toBeNull();
		expect(observeChatPresence(raw, "roster")).toBeNull();
	}
	for (const raw of [undefined, null, false, 1, "peer", []]) {
		expect(observeChatPresence(raw, "delta")).toBeNull();
	}
});

test("leave retains its ignored extras while roster still observes the upsert fields", () => {
	const raw = {
		type: "presence_leave",
		member_id: "peer",
		name: {},
		typing: "bad",
	};
	expect(observeChatPresence(raw, "delta")).toEqual({
		kind: "leave",
		memberId: "peer",
		raw,
	});
	expect(observeChatPresence(raw, "roster")).toBeNull();
	const roster = {
		type: "presence_leave",
		member_id: "peer",
		name: "Ada",
		typing: true,
	};
	expect(observeChatPresence(roster, "roster")).toMatchObject({
		kind: "upsert",
		name: "Ada",
		typing: true,
	});
});
