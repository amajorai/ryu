import type { MailMessage, MailSendPayload } from "@ryu/app-host/rpc";
import { mailMessageSchema } from "@ryu/app-host/rpc";
import { z } from "zod";
import type { ApiTarget } from "../../lib/api/client.ts";
import { sendMessage } from "../../lib/api/mail.ts";
import { mailAttachmentInputSchema } from "./node-response-contracts.ts";

/** The actual Companion-to-node Mail mapping used by PluginHostPanel. */
export function sendCompanionMail(
	target: ApiTarget,
	input: MailSendPayload
): Promise<MailMessage> {
	const {
		attachments,
		bcc,
		cc,
		clientId,
		headers,
		html,
		idempotencyKey,
		inboxId,
		inReplyTo,
		labels,
		references,
		replyTo,
		subject,
		text,
		trackOpens,
		to,
	} = input;
	return sendMessage(
		target,
		inboxId,
		{
			attachments: z
				.array(mailAttachmentInputSchema)
				.optional()
				.parse(attachments),
			bcc,
			cc,
			clientId,
			headers,
			html,
			inReplyTo,
			labels,
			references: Array.isArray(references) ? references.join(" ") : references,
			replyTo,
			subject,
			text,
			trackOpens,
			to,
		},
		idempotencyKey
	).then(mailMessageSchema.parse);
}
