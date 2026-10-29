import {
	isNativeBoolean,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import type { RealtimeHandlers } from "@ryuhq/core-client/realtime.ts";
import { z } from "zod";

type PresenceInput = Parameters<NonNullable<RealtimeHandlers["onPresence"]>>[0];
const presenceFields = z.record(z.string(), z.unknown());

/** Only these observed chat fields are checked. The complete native transport
 * value is retained; future app presence fields are neither interpreted nor
 * promoted to a chat message contract. Core delivers parsed JSON here. */
export function observeChatPresence(
	value: PresenceInput,
	mode: "delta" | "roster"
) {
	const parsed = presenceFields.safeParse(value);
	if (!parsed.success) {
		return null;
	}
	const fields = parsed.data;
	const memberId = fields.member_id;
	if (!isNativeText(memberId)) {
		return null;
	}
	// Leave consumes no name or typing fields. A roster entry remains an upsert,
	// including an entry whose unrelated type field happens to say leave.
	if (mode === "delta" && fields.type === "presence_leave") {
		return { kind: "leave" as const, memberId, raw: value };
	}
	const name = fields.name;
	if (name !== undefined && name !== null && !isNativeText(name)) {
		return null;
	}
	const typing = fields.typing;
	if (typing !== undefined && typing !== null && !isNativeBoolean(typing)) {
		return null;
	}
	return { kind: "upsert" as const, memberId, name, typing, raw: value };
}
