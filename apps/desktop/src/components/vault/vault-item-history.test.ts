import { expect, test } from "bun:test";
import { translate } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { VaultItemEvent } from "@/src/lib/api/vault-items.ts";
import { describeItemEvent, itemEventActor } from "./vault-item-history.ts";

const tl = translate as LiteralMessage;

function event(name: string, data: unknown = {}): VaultItemEvent {
	return {
		actorKind: "user",
		createdAt: 1,
		data: data as VaultItemEvent["data"],
		itemId: "vi_1",
		name,
		seq: 1,
		version: 1,
	};
}

test("each event reads as one sentence naming fields, never values", () => {
	expect(
		describeItemEvent(event("created", { fieldsSet: ["username"] }), tl)
	).toBe("Created with username");
	expect(describeItemEvent(event("created"), tl)).toBe("Created");
	expect(
		describeItemEvent(
			event("updated", { fieldsSet: ["password"], fieldsCleared: ["totp"] }),
			tl
		)
	).toBe("Updated: set password; cleared totp");
	expect(describeItemEvent(event("updated", { fieldsSet: [] }), tl)).toBe(
		"Updated"
	);
	expect(
		describeItemEvent(
			event("status_changed", { from: "ready", to: "pending_collection" }),
			tl
		)
	).toBe("Status changed to waiting for collection");
	expect(describeItemEvent(event("revealed", { field: "password" }), tl)).toBe(
		"Revealed password"
	);
	expect(describeItemEvent(event("deleted"), tl)).toBe("Deleted");
	expect(describeItemEvent(event("card_used"), tl)).toBe("Card used");
	expect(describeItemEvent(event("brand_new_thing"), tl)).toBe(
		"brand new thing"
	);
});

test("malformed data degrades to the bare sentence and the actor names its id", () => {
	expect(describeItemEvent(event("created", { fieldsSet: [1, "a"] }), tl)).toBe(
		"Created with a"
	);
	expect(describeItemEvent(event("updated", null), tl)).toBe("Updated");
	expect(itemEventActor(event("created"))).toBe("user");
	expect(itemEventActor({ ...event("created"), actorId: "ada" })).toBe(
		"user ada"
	);
});
