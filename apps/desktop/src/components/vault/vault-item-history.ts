// One line per item timeline event. Events carry field names and statuses,
// never values, so nothing here can reveal a secret.

import type { LiteralMessage } from "@ryu/i18n/react";
import type { VaultItemEvent } from "@/src/lib/api/vault-items.ts";

function names(data: unknown, key: string): string[] {
	if (typeof data !== "object" || data === null) {
		return [];
	}
	const value = (data as Record<string, unknown>)[key];
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function word(data: unknown, key: string): string {
	if (typeof data !== "object" || data === null) {
		return "";
	}
	const value = (data as Record<string, unknown>)[key];
	return typeof value === "string" ? value : "";
}

function statusLabel(status: string, tl: LiteralMessage): string {
	if (status === "pending_collection") {
		return tl("waiting for collection");
	}
	return status === "ready" ? tl("ready") : status;
}

/** What happened, in one sentence. */
export function describeItemEvent(
	event: VaultItemEvent,
	tl: LiteralMessage
): string {
	const set = names(event.data, "fieldsSet");
	const cleared = names(event.data, "fieldsCleared");
	switch (event.name) {
		case "created":
			return set.length
				? tl("Created with {fields}", { fields: set.join(", ") })
				: tl("Created");
		case "updated": {
			const parts = [
				set.length ? tl("set {fields}", { fields: set.join(", ") }) : "",
				cleared.length
					? tl("cleared {fields}", { fields: cleared.join(", ") })
					: "",
			].filter(Boolean);
			return parts.length
				? tl("Updated: {changes}", { changes: parts.join("; ") })
				: tl("Updated");
		}
		case "status_changed":
			return tl("Status changed to {status}", {
				status: statusLabel(word(event.data, "to"), tl),
			});
		case "revealed":
			return tl("Revealed {field}", { field: word(event.data, "field") });
		case "deleted":
			return tl("Deleted");
		case "card_used":
			return tl("Card used");
		case "card_use_blocked":
			return tl("Card use blocked");
		case "card_use_refunded":
			return tl("Card use refunded");
		case "card_approval_requested":
			return tl("Card use approval requested");
		case "card_approval_approved":
			return tl("Card use approved");
		default:
			return event.name.replaceAll("_", " ");
	}
}

/** Who did it: `user ada`, or just the actor kind. */
export function itemEventActor(event: VaultItemEvent): string {
	return event.actorId
		? `${event.actorKind} ${event.actorId}`
		: event.actorKind;
}
