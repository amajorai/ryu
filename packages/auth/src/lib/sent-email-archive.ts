import { User } from "@ryu/db/models/auth.model";
import {
	SENT_EMAIL_MAX_HTML_LENGTH,
	SentEmail,
} from "@ryu/db/models/sent-email.model";
import type { SentEmailRecord } from "@ryu/email";

function clip(value: string | null): string | null {
	return value && value.length > SENT_EMAIL_MAX_HTML_LENGTH
		? value.slice(0, SENT_EMAIL_MAX_HTML_LENGTH)
		: value;
}

/**
 * Persist one `sendEmail` outcome to the official sent-email archive, linked
 * to the account that owns the recipient address at send time. Users see
 * their rows in Account settings → Emails; admins see every row.
 */
export async function recordSentEmail(record: SentEmailRecord): Promise<void> {
	const owner = await User.findOne({ email: record.to })
		.select({ _id: 1 })
		.lean();
	await SentEmail.create({
		...record,
		userId: owner ? String(owner._id) : null,
		subject: record.subject.slice(0, 500),
		error: record.error?.slice(0, 1000) ?? null,
		html: clip(record.html),
		text: clip(record.text),
	});
}
