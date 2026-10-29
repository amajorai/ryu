import { toast } from "@ryu/ui/components/sileo.tsx";
import { z } from "zod";

/** Minimal message shape accepted by the transcript formatter. */
export interface TranscriptMessage {
	content?: string;
	createdAt?: Date | string;
	metadata?: {
		author?: {
			id?: string;
			name?: string;
		};
	};
	parts?: unknown[];
	role: string;
	/** Alternative timestamp field used by the Message type. */
	timestamp?: number;
}

/** Options for formatting the transcript. */
export interface TranscriptOptions {
	/** Default user name to use when message metadata doesn't have author info. */
	defaultUserName?: string;
}

export interface MarkdownTranscriptOptions extends TranscriptOptions {
	/** Optional level-one heading placed above the transcript. */
	title?: string;
}

// Only the text-part projection is consumed by the clipboard formatter. Other
// native SDK parts remain untouched and are omitted from the transcript.
const transcriptTextPartSchema = z.object({
	type: z.literal("text"),
	text: z.string(),
});
function textFromMessage(message: TranscriptMessage): string {
	if (Array.isArray(message.parts) && message.parts.length > 0) {
		return message.parts
			.flatMap((part) => {
				const parsed = transcriptTextPartSchema.safeParse(part);
				return parsed.success ? [parsed.data.text] : [];
			})
			.join("\n\n")
			.trim();
	}
	const content = z.string().safeParse(message.content);
	return content.success ? content.data.trim() : "";
}

function formatTimestampForTranscript(date: Date): string {
	const day = date.getDate();
	const month = date.getMonth() + 1;
	const year = date.getFullYear();
	const hours = date.getHours();
	const minutes = date.getMinutes();
	const ampm = hours >= 12 ? "pm" : "am";
	const displayHours = hours % 12 || 12;
	const displayMinutes = minutes.toString().padStart(2, "0");
	return `${day}/${month}/${year}, ${displayHours}:${displayMinutes} ${ampm}`;
}

function getAuthorLabel(
	message: TranscriptMessage,
	defaultUserName?: string
): string {
	if (message.role === "assistant") {
		return "Assistant";
	}
	if (message.role === "user") {
		const author = message.metadata?.author;
		const name = author?.name || author?.id;
		if (name) {
			return name;
		}
		return defaultUserName || "User";
	}
	return message.role.charAt(0).toUpperCase() + message.role.slice(1);
}

/** Format user/assistant turns as plain text for the clipboard. */
export function formatChatTranscript(
	messages: TranscriptMessage[],
	options?: TranscriptOptions
): string {
	const blocks: string[] = [];
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "assistant") {
			continue;
		}
		const text = textFromMessage(message);
		if (!text) {
			continue;
		}
		const authorLabel = getAuthorLabel(message, options?.defaultUserName);
		const createdAt = message.createdAt
			? new Date(message.createdAt)
			: message.timestamp
				? new Date(message.timestamp)
				: null;
		const timestamp = createdAt
			? `, [${formatTimestampForTranscript(createdAt)}]`
			: "";
		blocks.push(`${authorLabel}${timestamp}:\n${text}`);
	}
	return blocks.join("\n\n");
}

function markdownHeadingText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/** Format user and assistant turns as portable Markdown. */
export function formatChatTranscriptAsMarkdown(
	messages: TranscriptMessage[],
	options?: MarkdownTranscriptOptions
): string {
	const blocks: string[] = [];
	const title = markdownHeadingText(options?.title ?? "");
	if (title) {
		blocks.push(`# ${title}`);
	}
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "assistant") {
			continue;
		}
		const text = textFromMessage(message);
		if (!text) {
			continue;
		}
		const author = markdownHeadingText(
			getAuthorLabel(message, options?.defaultUserName)
		);
		const createdAt = message.createdAt
			? new Date(message.createdAt)
			: message.timestamp
				? new Date(message.timestamp)
				: null;
		const timestamp = createdAt
			? ` · ${formatTimestampForTranscript(createdAt)}`
			: "";
		blocks.push(`## ${author}${timestamp}\n\n${text}`);
	}
	return blocks.join("\n\n");
}

/**
 * Copy a chat transcript to the clipboard and toast the result.
 * Accepts either an already-loaded message list or an async loader.
 */
export async function copyChatTranscript(
	source: TranscriptMessage[] | (() => Promise<TranscriptMessage[]>),
	options?: TranscriptOptions
): Promise<void> {
	try {
		const messages = Array.isArray(source) ? source : await source();
		const transcript = formatChatTranscript(messages, options);
		if (!transcript) {
			toast.info("Nothing to copy");
			return;
		}
		await navigator.clipboard.writeText(transcript);
		toast.success("Copied to clipboard");
	} catch {
		toast.error("Couldn't copy transcript");
	}
}

/** Copy a chat transcript as Markdown and report the result. */
export async function copyChatTranscriptAsMarkdown(
	source: TranscriptMessage[] | (() => Promise<TranscriptMessage[]>),
	options?: MarkdownTranscriptOptions
): Promise<void> {
	try {
		const messages = Array.isArray(source) ? source : await source();
		const transcript = formatChatTranscriptAsMarkdown(messages, options);
		if (!transcript) {
			toast.info("Nothing to copy");
			return;
		}
		await navigator.clipboard.writeText(transcript);
		toast.success("Copied Markdown to clipboard");
	} catch {
		toast.error("Couldn't copy chat as Markdown");
	}
}
