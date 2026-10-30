import type { InputBarInfoBar } from "@ryu/blocks/desktop/agent-elements/input-bar";

/**
 * A failure as the widget shows it: one sentence for the visitor, and the raw
 * message kept for "Copy details" instead of being printed in the panel.
 */
export type WidgetErrorKind =
	| "answer"
	| "browser-model"
	| "node"
	/** The visitor's own address input; its validation message is the sentence. */
	| "node-address";

export interface WidgetError {
	details: string;
	kind: WidgetErrorKind;
	/** The question to send again on Retry, for a failed answer. */
	question?: string;
	sentence: string;
}

const SENTENCES: Record<Exclude<WidgetErrorKind, "node-address">, string> = {
	answer: "The assistant couldn't answer that.",
	"browser-model": "The browser model couldn't load.",
	node: "Couldn't connect to your Core. Check the address and token.",
};

export function widgetError(
	kind: WidgetErrorKind,
	cause: unknown,
	question?: string
): WidgetError {
	const details =
		cause instanceof Error ? cause.message : String(cause ?? "Unknown error");
	const sentence = kind === "node-address" ? details : SENTENCES[kind];
	return { details, kind, question, sentence };
}

function copyDetails(details: string): void {
	if (typeof navigator === "undefined" || !navigator.clipboard) {
		return;
	}
	navigator.clipboard.writeText(details).catch(() => {
		// Clipboard access can be denied by the host page; nothing else to do.
	});
}

/**
 * The composer info bar for an error (sentence plus actions) or a notice.
 * `retry` is omitted when retrying needs the visitor to edit a form first.
 */
export function widgetInfoBar({
	clearError,
	clearNotice,
	error,
	notice,
	retry,
}: {
	clearError: () => void;
	clearNotice: () => void;
	error: WidgetError | null;
	notice: string | null;
	retry?: () => void;
}): InputBarInfoBar | undefined {
	if (error) {
		const actions: NonNullable<InputBarInfoBar["actions"]> = [
			{
				label: "Copy details",
				onClick: () => copyDetails(error.details),
				variant: "ghost",
			},
		];
		if (retry) {
			actions.push({
				label: "Retry",
				onClick: () => {
					clearError();
					retry();
				},
				variant: "secondary",
			});
		}
		return {
			actions,
			description: error.sentence,
			onClose: clearError,
			variant: "destructive",
		};
	}
	return notice ? { description: notice, onClose: clearNotice } : undefined;
}
