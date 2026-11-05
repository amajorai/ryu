import type { LiteralMessage } from "@ryu/i18n";

/** The DOM popover Pierre's editor shows over a text selection: "Add to chat"
    (when the host accepts selections) and "Copy". Pierre renders it outside
    React, so the caller passes its translator and rebuilds the popover when the
    locale changes. */
export function createSelectionAction(
	filePath: string | undefined,
	onSelection: ((text: string) => void) | undefined,
	tl: LiteralMessage
) {
	return (context: { close: () => void; getSelectionText: () => string }) => {
		const root = document.createElement("div");
		root.className =
			"flex items-center gap-1 rounded-lg border border-border/70 bg-popover p-1 text-popover-foreground shadow-xl";

		const copy = document.createElement("button");
		copy.className = "rounded-md px-2 py-1 text-xs hover:bg-muted";
		copy.textContent = tl("Copy");
		copy.type = "button";
		copy.addEventListener("click", () => {
			const text = context.getSelectionText();
			if (text.trim()) {
				void navigator.clipboard?.writeText(text);
			}
			context.close();
		});

		if (onSelection) {
			const addToChat = document.createElement("button");
			addToChat.className =
				"rounded-md px-2 py-1 font-medium text-xs hover:bg-muted";
			addToChat.textContent = tl("Add to chat");
			addToChat.type = "button";
			addToChat.addEventListener("click", () => {
				const text = context.getSelectionText();
				if (text.trim()) {
					onSelection(filePath ? `${filePath}\n\n${text}` : text);
				}
				context.close();
			});
			root.append(addToChat);
		}
		root.append(copy);
		return root;
	};
}
