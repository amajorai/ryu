import { findMentionAt } from "./mention-format.ts";
import type { MentionItem } from "./types.ts";

/**
 * Staged composer attachments double as inline mentions: every image becomes an
 * `@image-N` token and every other file an `@file-N` token, so a prompt can say
 * "@image-1 into @image-2's face" instead of relying on attachment order alone.
 *
 * Labels carry no spaces on purpose: a sent message is rendered without the
 * composer's attachment items, and a space-free token stays one mention there.
 * Numbers follow the staged order, which is also the order the files ride the
 * turn, so `@image-1` is always the first image part the model receives.
 */
export interface ComposerAttachmentLabel {
	id: string;
	kind: "file" | "image";
	label: string;
	url?: string;
}

interface StagedImage {
	filename: string;
	id: string;
	mimeType?: string;
	url: string;
}

interface StagedFile {
	filename: string;
	id: string;
}

const ATTACHMENT_MENTION_ID_PREFIX = "attachment:";

function isImageAttachment(image: StagedImage): boolean {
	return !image.mimeType || image.mimeType.startsWith("image/");
}

/** Number staged attachments: images and other files are counted separately. */
export function labelComposerAttachments(
	images: readonly StagedImage[],
	files: readonly StagedFile[]
): ComposerAttachmentLabel[] {
	let imageCount = 0;
	let fileCount = 0;
	const labels: ComposerAttachmentLabel[] = [];
	for (const image of images) {
		if (isImageAttachment(image)) {
			imageCount += 1;
			labels.push({
				id: image.id,
				kind: "image",
				label: `image-${imageCount}`,
				url: image.url,
			});
		} else {
			fileCount += 1;
			labels.push({ id: image.id, kind: "file", label: `file-${fileCount}` });
		}
	}
	for (const file of files) {
		fileCount += 1;
		labels.push({ id: file.id, kind: "file", label: `file-${fileCount}` });
	}
	return labels;
}

/** The mention item the composer resolves an attachment token against. */
export function attachmentMentionItem(
	attachment: ComposerAttachmentLabel
): MentionItem {
	return {
		id: `${ATTACHMENT_MENTION_ID_PREFIX}${attachment.id}`,
		kind: attachment.kind,
		label: attachment.label,
	};
}

function attachmentIdOf(item: MentionItem | undefined): string | undefined {
	return item?.id?.startsWith(ATTACHMENT_MENTION_ID_PREFIX)
		? item.id.slice(ATTACHMENT_MENTION_ID_PREFIX.length)
		: undefined;
}

/** Remove `[start, end)` plus one adjoining space so no double gap remains. */
function removeRange(text: string, start: number, end: number) {
	if (text[end] === " ") {
		return { text: text.slice(0, start) + text.slice(end + 1), start };
	}
	if (start > 0 && text[start - 1] === " ") {
		return {
			text: text.slice(0, start - 1) + text.slice(end),
			start: start - 1,
		};
	}
	return { text: text.slice(0, start) + text.slice(end), start };
}

/**
 * Keep attachment tokens pointing at the same files after the staged list
 * changes: a removed attachment drops its token, and the survivors are
 * renumbered in one pass (so `@image-3` → `@image-2` never collides with the
 * old `@image-2`).
 */
export function remapAttachmentMentions(
	text: string,
	previous: readonly ComposerAttachmentLabel[],
	next: readonly ComposerAttachmentLabel[]
): string {
	if (previous.length === 0 || !text.includes("@")) {
		return text;
	}
	const previousItems = previous.map(attachmentMentionItem);
	const nextLabels = new Map(next.map((item) => [item.id, item.label]));
	let output = text;
	let index = 0;
	while (index < output.length) {
		const match = findMentionAt(output, index, previousItems);
		const attachmentId = attachmentIdOf(match?.item);
		if (!(match && attachmentId)) {
			index += 1;
			continue;
		}
		const label = nextLabels.get(attachmentId);
		if (label === undefined) {
			const removed = removeRange(output, index, match.end);
			output = removed.text;
			index = removed.start;
			continue;
		}
		const token = `@${label}`;
		output = output.slice(0, index) + token + output.slice(match.end);
		index += token.length;
	}
	return output;
}

/** Append a token for each newly staged attachment the draft doesn't mention. */
export function appendAttachmentMentions(
	text: string,
	added: readonly ComposerAttachmentLabel[]
): string {
	let output = text;
	for (const attachment of added) {
		const item = attachmentMentionItem(attachment);
		let present = false;
		for (let index = 0; index < output.length && !present; index += 1) {
			present = findMentionAt(output, index, [item])?.item === item;
		}
		if (present) {
			continue;
		}
		const base = output.trimEnd();
		const separator = base === "" ? "" : " ";
		output = `${base}${separator}@${attachment.label} `;
	}
	return output;
}

/**
 * Move the token at `[start, end)` to `dropIndex` (an index into the original
 * text), keeping single spaces around it. Returns `null` for a no-op drop.
 */
export function moveComposerToken(
	text: string,
	start: number,
	end: number,
	dropIndex: number
): { caret: number; text: string } | null {
	if (dropIndex >= start && dropIndex <= end) {
		return null;
	}
	const token = text.slice(start, end);
	const removed = removeRange(text, start, end);
	const rest = removed.text;
	const shifted =
		dropIndex > removed.start
			? dropIndex - (text.length - rest.length)
			: dropIndex;
	const at = Math.max(0, Math.min(rest.length, shifted));
	const before = rest.slice(0, at);
	const after = rest.slice(at);
	const lead = before === "" || /\s$/.test(before) ? "" : " ";
	const trail = after === "" || /^[\s.,;:!?'")\]}]/.test(after) ? "" : " ";
	const next = `${before}${lead}${token}${trail}${after}`;
	if (next === text) {
		return null;
	}
	return { caret: before.length + lead.length + token.length, text: next };
}
