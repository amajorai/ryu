import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";
// Typed client for durable per-human conversation read markers.
//
// Read markers are separate from the conversation message payload: one bulk
// snapshot restores the Instagram-style avatar indicators, while the bounded
// POST lets a viewport acknowledge several visible messages in one request.

import { z } from "zod";

import type {
	MessageReadReceipt,
	MessageReadReceiptUser,
} from "../read-receipts.ts";
import { type ApiTarget, request } from "./client.ts";

const optionalReceiptStringSchema = z.string().optional().catch(undefined);
const readReceiptWireSchema = z.object({
	messageId: optionalReceiptStringSchema,
	readAt: optionalReceiptStringSchema,
	userId: optionalReceiptStringSchema,
	userName: optionalReceiptStringSchema,
});
const readReceiptUserWireSchema = z.object({
	avatar: optionalReceiptStringSchema,
	id: optionalReceiptStringSchema,
	name: optionalReceiptStringSchema,
});
type ReadReceiptWire = z.infer<typeof readReceiptWireSchema>;
type ReadReceiptUserWire = z.infer<typeof readReceiptUserWireSchema>;
const readReceiptsSnapshotWireSchema = z.object({
	receipts: z.array(readReceiptWireSchema).nullish(),
	users: z.array(readReceiptUserWireSchema).nullish(),
});
const markReadWireSchema = z.object({
	receipts: z.array(readReceiptWireSchema).nullish(),
});

export interface MessageReadReceiptsSnapshot {
	receipts: MessageReadReceipt[];
	users: MessageReadReceiptUser[];
}

function receiptFromWire(raw: ReadReceiptWire): MessageReadReceipt | null {
	const messageId = raw.messageId?.trim() ?? "";
	const userId = raw.userId?.trim() ?? "";
	const readAt = raw.readAt?.trim() ?? "";
	if (!(messageId && userId && readAt)) {
		return null;
	}
	const userName = raw.userName?.trim() ?? "";
	const receipt: MessageReadReceipt = { messageId, readAt, userId };
	if (userName) {
		receipt.userName = userName;
	}
	return receipt;
}

function userFromWire(raw: ReadReceiptUserWire): MessageReadReceiptUser | null {
	const id = raw.id?.trim() ?? "";
	if (!id) {
		return null;
	}
	const name = raw.name?.trim() ?? "";
	return {
		avatar: raw.avatar?.trim() || undefined,
		id,
		name: name || id,
	};
}

/** Load every read marker and its scoped display metadata for one conversation. */
export async function listMessageReadReceipts(
	target: ApiTarget,
	conversationId: string
): Promise<MessageReadReceiptsSnapshot> {
	const body = readReceiptsSnapshotWireSchema.parse(
		await request(
			target,
			`/api/conversations/${encodeURIComponent(conversationId)}/read-receipts`,
			{},
			gatewayJsonValueSchema
		)
	);
	return {
		receipts: (body.receipts ?? []).flatMap((receipt) => {
			const normalized = receiptFromWire(receipt);
			return normalized ? [normalized] : [];
		}),
		users: (body.users ?? []).flatMap((user) => {
			const normalized = userFromWire(user);
			return normalized ? [normalized] : [];
		}),
	};
}

/** Mark visible messages read as the authenticated caller. */
export async function markMessageRead(
	target: ApiTarget,
	conversationId: string,
	messageIds: readonly string[]
): Promise<MessageReadReceipt[]> {
	const body = markReadWireSchema.parse(
		await request(
			target,
			`/api/conversations/${encodeURIComponent(conversationId)}/read`,
			{
				body: { messageIds: [...new Set(messageIds)] },
				method: "POST",
			},
			gatewayJsonValueSchema
		)
	);
	return (body.receipts ?? []).flatMap((receipt) => {
		const normalized = receiptFromWire(receipt);
		return normalized ? [normalized] : [];
	});
}
