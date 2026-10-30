"use client";

import { File01Icon, Image01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { useEffect, useMemo, useRef } from "react";
import {
	appendAttachmentMentions,
	attachmentMentionItem,
	labelComposerAttachments,
	remapAttachmentMentions,
} from "./composer-attachment-mentions.ts";
import type { AttachedFile, AttachedImage } from "./input-bar-types.ts";
import type { MentionItem } from "./types.ts";

/**
 * Staged attachments are mentionable too: `@image-1`, `@file-1`, … resolve
 * to chips (with the image's own thumbnail) alongside the host's directory.
 */
export function useComposerAttachmentMentions({
	attachedFiles,
	attachedImages,
	hostMentionItems,
	input,
	setInput,
}: {
	attachedFiles: AttachedFile[];
	attachedImages: AttachedImage[];
	hostMentionItems: MentionItem[] | undefined;
	input: string;
	setInput: (v: string) => void;
}) {
	const attachmentLabels = useMemo(
		() => labelComposerAttachments(attachedImages, attachedFiles),
		[attachedImages, attachedFiles]
	);
	const mentionItems = useMemo((): MentionItem[] | undefined => {
		if (attachmentLabels.length === 0) {
			return hostMentionItems;
		}
		const attachmentItems = attachmentLabels.map((attachment) => {
			const thumbnail = attachment.url ? safeMediaUrl(attachment.url) : null;
			return {
				...attachmentMentionItem(attachment),
				icon:
					attachment.kind === "image" ? (
						<HugeiconsIcon className="size-3.5" icon={Image01Icon} />
					) : (
						<HugeiconsIcon className="size-3.5" icon={File01Icon} />
					),
				visualIcon: thumbnail ? (
					<img
						alt=""
						className="size-3.5 rounded-[3px] object-cover"
						draggable={false}
						height={14}
						src={thumbnail}
						width={14}
					/>
				) : undefined,
			};
		});
		return [...attachmentItems, ...(hostMentionItems ?? [])];
	}, [attachmentLabels, hostMentionItems]);
	// Each newly staged attachment appends its token to the end of the draft;
	// removing one drops its token and renumbers the rest so every token keeps
	// pointing at the same file. Seeded with the mount-time list so a remount
	// never re-appends tokens the user already deleted.
	const inputRef = useRef(input);
	inputRef.current = input;
	const previousAttachmentLabelsRef = useRef(attachmentLabels);
	useEffect(() => {
		const previous = previousAttachmentLabelsRef.current;
		if (previous === attachmentLabels) {
			return;
		}
		previousAttachmentLabelsRef.current = attachmentLabels;
		const current = inputRef.current;
		const previousIds = new Set(previous.map((item) => item.id));
		const next = appendAttachmentMentions(
			remapAttachmentMentions(current, previous, attachmentLabels),
			attachmentLabels.filter((item) => !previousIds.has(item.id))
		);
		if (next !== current) {
			inputRef.current = next;
			setInput(next);
		}
	}, [attachmentLabels, setInput]);
	return mentionItems;
}
