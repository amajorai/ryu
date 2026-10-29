import type { UIMessage } from "ai";
import { z } from "zod";

const displayMetadataSchema = z.object({ ryuUserText: z.string() });

const CONTEXT_PREFIX =
	"The user is working in Ryu and currently has this open. Use it as context for their request.\n\n<page-context>\n";
const CONTEXT_END = "\n</page-context>\n\n";

/** Page context is untrusted (a PR diff, a document): neutralize any text that
 *  would close or reopen the wrapper, so it cannot step outside the block. */
function escapeContextDelimiters(block: string): string {
	return block.replace(/<(\/?)(page-context)/gi, "‹$1$2");
}

export function composeAssistantContext(
	content: string,
	block: string
): string {
	return block
		? `${CONTEXT_PREFIX}${escapeContextDelimiters(block)}${CONTEXT_END}${content}`
		: content;
}

export function assistantDisplayMessages(messages: UIMessage[]): UIMessage[] {
	return messages.map((message) => {
		if (message.role !== "user") {
			return message;
		}
		const textIndex = message.parts.findIndex((part) => part.type === "text");
		const textPart = message.parts[textIndex];
		if (textPart?.type !== "text") {
			return message;
		}
		const metadata = displayMetadataSchema.safeParse(message.metadata);
		const displayText = metadata.success
			? metadata.data.ryuUserText
			: undefined;
		if (displayText === undefined || displayText === textPart.text) {
			return message;
		}
		return {
			...message,
			parts: message.parts.map((part, index) =>
				index === textIndex && part.type === "text"
					? { ...part, text: displayText }
					: part
			),
		};
	});
}
