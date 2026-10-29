import { z } from "zod";

/** One verified human's durable read marker for one conversation message. */
export interface MessageReadReceipt {
	messageId: string;
	readAt: string;
	userId: string;
	userName?: string;
}

/** Scoped display metadata for one receipt-bearing human. */
export interface MessageReadReceiptUser {
	avatar?: string;
	id: string;
	name: string;
}

/** Merge receipt rows without double-counting duplicate realtime or HTTP data. */
export function mergeReadReceipts(
	current: readonly MessageReadReceipt[],
	next: readonly MessageReadReceipt[]
): MessageReadReceipt[] {
	const byKey = new Map<string, MessageReadReceipt>();
	for (const receipt of [...current, ...next]) {
		const key = `${receipt.messageId}\u0000${receipt.userId}`;
		const existing = byKey.get(key);
		if (!existing) {
			byKey.set(key, receipt);
			continue;
		}
		// The first durable marker wins. A duplicate event may carry a display
		// name that the initial snapshot did not, so enrich the existing row
		// without changing its read time.
		if (!existing.userName && receipt.userName) {
			byKey.set(key, { ...existing, userName: receipt.userName });
		}
	}
	return [...byKey.values()].sort((a, b) => {
		const byTime = a.readAt.localeCompare(b.readAt);
		if (byTime !== 0) {
			return byTime;
		}
		return `${a.messageId}:${a.userId}`.localeCompare(
			`${b.messageId}:${b.userId}`
		);
	});
}

const receiptFrameInputSchema = z.json();
export type ReadReceiptFrameInput =
	| z.infer<typeof receiptFrameInputSchema>
	| undefined;
const optionalReceiptString = z.string().optional().catch(undefined);
export const readReceiptFrameSchema = z.object({
	type: z.enum(["readReceipt", "read_receipt"]),
	conversationId: optionalReceiptString,
	conversation_id: optionalReceiptString,
	messageId: optionalReceiptString,
	message_id: optionalReceiptString,
	userId: optionalReceiptString,
	user_id: optionalReceiptString,
	readAt: optionalReceiptString,
	read_at: optionalReceiptString,
	userName: optionalReceiptString,
	user_name: optionalReceiptString,
});

/** Decode a realtime read-receipt frame for the active room. */
export function readReceiptFromFrame(
	data: ReadReceiptFrameInput,
	conversationId: string | null
): MessageReadReceipt | null {
	const parsed = readReceiptFrameSchema.safeParse(data);
	if (!parsed.success) {
		return null;
	}
	const frame = parsed.data;
	const frameConversationId =
		frame.conversationId ?? frame.conversation_id ?? null;
	if (conversationId && frameConversationId !== conversationId) {
		return null;
	}
	const messageId = (frame.messageId ?? frame.message_id ?? "").trim();
	const userId = (frame.userId ?? frame.user_id ?? "").trim();
	const readAt = (frame.readAt ?? frame.read_at ?? "").trim();
	if (!(messageId && userId && readAt)) {
		return null;
	}
	const userName = (frame.userName ?? frame.user_name ?? "").trim();
	const receipt: MessageReadReceipt = { messageId, readAt, userId };
	if (userName) {
		receipt.userName = userName;
	}
	return receipt;
}
