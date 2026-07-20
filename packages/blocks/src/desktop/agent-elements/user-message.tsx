import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import type { UIMessage } from "ai";
import { memo, useEffect, useRef, useState } from "react";
import { CollapsibleText } from "./collapsible-text.tsx";
import { ImageLightbox } from "./image-lightbox.tsx";
import { FileAttachment } from "./input/file-attachment.tsx";
import {
	messageSelectableProps,
	QuoteBlock,
	splitLeadingQuote,
} from "./quote.tsx";

export interface UserMessageProps {
	className?: string;
	/** When true, the bubble is replaced by an inline editor (ChatGPT/Claude-style
	 * message editing). Saving calls `onEditSubmit`; Escape/Cancel calls
	 * `onEditCancel`. */
	editing?: boolean;
	/**
	 * When true (default) clicking an attached image opens a fullscreen
	 * lightbox preview. Set to false to render images as plain thumbnails.
	 */
	enableImagePreview?: boolean;
	message: UIMessage;
	onEditCancel?: () => void;
	onEditSubmit?: (text: string) => void;
}

type MessagePart = UIMessage["parts"][number];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isTextPart(part: MessagePart): part is { type: "text"; text: string } {
	return (
		part.type === "text" &&
		typeof (part as { text?: unknown }).text === "string"
	);
}

function getImageUrlFromPart(part: unknown): string | null {
	if (!isRecord(part)) {
		return null;
	}
	const type = part.type;
	if (typeof type !== "string") {
		return null;
	}

	if (type === "image") {
		const imagePart = part as { url?: string; image?: string };
		return imagePart.url ?? imagePart.image ?? null;
	}

	if (type === "data-image") {
		const dataPart = part as { data?: { url?: string } };
		return dataPart.data?.url ?? null;
	}

	if (type === "file") {
		const filePart = part as { mimeType?: string; url?: string; data?: string };
		if (filePart.mimeType?.startsWith("image/")) {
			if (filePart.url) {
				return filePart.url;
			}
			if (filePart.data) {
				return `data:${filePart.mimeType};base64,${filePart.data}`;
			}
		}
	}

	return null;
}

interface FilePart {
	fileName?: string;
	filename?: string;
	mimeType?: string;
	name?: string;
	size?: number;
	type: "file";
	url?: string;
}

/**
 * Sender attribution for a user bubble, carried on the AI SDK message's
 * `metadata`. Set by the chat surface when it live-inserts a message authored by
 * another human (multi-user collaboration). Absent on the local user's own
 * optimistic messages, so only OTHER people get a name label.
 */
interface MessageAuthor {
	/** Stable Core user id (`author_user_id`). */
	id?: string;
	/** Display name (Core's `author_name`), falling back to the user id/email. */
	name?: string;
}

function getAuthor(message: UIMessage): MessageAuthor | null {
	const metadata = (message as { metadata?: { author?: MessageAuthor } })
		.metadata;
	const author = metadata?.author;
	if (!author) {
		return null;
	}
	const label = author.name || author.id;
	if (!label) {
		return null;
	}
	return author;
}

function getFileFromPart(part: unknown) {
	if (!isRecord(part)) {
		return null;
	}
	if (part.type !== "file") {
		return null;
	}
	const filePart = part as FilePart;
	const filename =
		filePart.filename || filePart.name || filePart.fileName || "Attachment";
	const isImage = filePart.mimeType?.startsWith("image/") ?? false;
	if (isImage) {
		return null;
	}
	return {
		filename,
		size: filePart.size,
	};
}

/**
 * Inline editor shown in place of a user bubble while editing. Enter saves
 * (Shift+Enter inserts a newline), Escape cancels. Mirrors the composer's
 * right-aligned bubble styling so the edit feels in-place.
 */
function UserMessageEditor({
	initialText,
	onSubmit,
	onCancel,
}: {
	initialText: string;
	onSubmit?: (text: string) => void;
	onCancel?: () => void;
}) {
	const [value, setValue] = useState(initialText);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		const el = textareaRef.current;
		if (el) {
			el.focus();
			// Place the caret at the end and grow to fit the content.
			el.setSelectionRange(el.value.length, el.value.length);
			el.style.height = "auto";
			el.style.height = `${el.scrollHeight}px`;
		}
	}, []);

	const submit = () => {
		const trimmed = value.trim();
		if (trimmed) {
			onSubmit?.(trimmed);
		}
	};

	return (
		<div className="flex w-full flex-col items-end gap-2">
			<div className="w-full max-w-[calc(95%-40px)] rounded-2xl bg-muted px-3.5 py-2">
				<textarea
					className="w-full resize-none bg-transparent text-foreground text-sm leading-5 outline-none"
					onChange={(event) => {
						setValue(event.target.value);
						event.target.style.height = "auto";
						event.target.style.height = `${event.target.scrollHeight}px`;
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							submit();
						} else if (event.key === "Escape") {
							event.preventDefault();
							onCancel?.();
						}
					}}
					ref={textareaRef}
					rows={1}
					value={value}
				/>
			</div>
			<div className="flex items-center gap-2">
				<Button
					className="h-7 rounded-full px-3 text-xs"
					onClick={onCancel}
					size="sm"
					type="button"
					variant="ghost"
				>
					Cancel
				</Button>
				<Button
					className="h-7 rounded-full px-3 text-xs"
					disabled={!value.trim()}
					onClick={submit}
					size="sm"
					type="button"
				>
					Send
				</Button>
			</div>
		</div>
	);
}

export const UserMessage = memo(function UserMessage({
	message,
	className,
	enableImagePreview = true,
	editing = false,
	onEditSubmit,
	onEditCancel,
}: UserMessageProps) {
	const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
	const textParts = message.parts?.filter(isTextPart) ?? [];
	const text = textParts.map((p) => p.text).join("");

	if (editing) {
		return (
			<UserMessageEditor
				initialText={text}
				onCancel={onEditCancel}
				onSubmit={onEditSubmit}
			/>
		);
	}
	// A message sent with a quote carries it as a leading markdown blockquote;
	// peel it back off so it renders as a styled QuoteBlock, not raw `> …` text.
	const { quote, body } = splitLeadingQuote(text);

	const images: string[] = [];
	const files: Array<{ filename: string; size?: number }> = [];
	for (const part of message.parts ?? []) {
		const imageUrl = getImageUrlFromPart(part);
		if (imageUrl) {
			images.push(imageUrl);
		}
		const file = getFileFromPart(part);
		if (file) {
			files.push(file);
		}
	}
	if (isRecord(message) && Array.isArray(message.experimental_attachments)) {
		for (const att of message.experimental_attachments as Array<{
			contentType?: string;
			url?: string;
		}>) {
			if (att.contentType?.startsWith("image/") && att.url) {
				images.push(att.url);
			}
		}
	}

	if (!text && images.length === 0 && files.length === 0) {
		return null;
	}

	const lightboxImages = images.map((url, i) => ({
		id: `${message.id}-img-${i}`,
		url,
		filename: `image-${i + 1}`,
	}));

	const author = getAuthor(message);

	return (
		<div className={cn("flex flex-col items-end gap-1", className)}>
			{author && (
				<div className="flex min-w-0 max-w-full items-center justify-end px-3.5 font-medium text-muted-foreground text-xs">
					{author.name || author.id}
				</div>
			)}
			{images.length > 0 &&
				images.map((url, i) => (
					<div
						className={cn(
							"max-w-[200px] rounded-2xl bg-foreground/4 p-1.5",
							enableImagePreview && "cursor-pointer"
						)}
						key={i}
						onClick={enableImagePreview ? () => setLightboxIndex(i) : undefined}
					>
						<img
							alt="attachment"
							className="block max-h-[120px] max-w-[184px] rounded-xl object-cover"
							src={url}
						/>
					</div>
				))}
			{enableImagePreview && lightboxImages.length > 0 && (
				<ImageLightbox
					images={lightboxImages}
					initialIndex={lightboxIndex ?? 0}
					onClose={() => setLightboxIndex(null)}
					open={lightboxIndex !== null}
				/>
			)}
			{files.length > 0 && (
				<div className="flex flex-col items-end gap-2">
					{files.map((file, i) => (
						<FileAttachment
							filename={file.filename}
							id={`${file.filename}-${i}`}
							key={`${file.filename}-${i}`}
							size={file.size}
						/>
					))}
				</div>
			)}
			{text && (
				<div className="ms-[70px] max-w-[calc(95%-40px)]">
					<div className="rounded-2xl bg-muted px-3.5 py-1.5 text-foreground text-sm transition-colors">
						{quote && <QuoteBlock text={quote} />}
						{body && (
							<CollapsibleText
								collapsedMaxHeightClass="max-h-[120px]"
								contentClassName="wrap-break-word whitespace-pre-wrap leading-5"
								fadeToClass="to-muted"
							>
								<p {...messageSelectableProps}>{body}</p>
							</CollapsibleText>
						)}
					</div>
				</div>
			)}
		</div>
	);
});
