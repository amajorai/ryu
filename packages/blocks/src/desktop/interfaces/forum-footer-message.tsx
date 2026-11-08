// The follow-on links under a forum list ("Browse all categories or view
// latest topics."), written as one whole message per set of actions so each
// locale owns the conjunction, the casing and the closing punctuation. The
// forum builds its actions from these fixed English labels; any other set
// falls back to one short sentence per action, with no joining word.
import { useRichLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { ReactNode } from "react";
import { TEXT_BUTTON } from "./forum-parts.tsx";

export interface ForumFooterAction {
	label: string;
	onClick: () => void;
}

const TAG_BY_LABEL: Readonly<Record<string, string>> = {
	"Browse all categories": "browse",
	"Clear search": "clear",
	"View latest topics": "latest",
};

/** The action buttons and their joining words, as one translated sentence. */
export function ForumFooterActions({
	actions,
}: {
	actions: readonly ForumFooterAction[];
}): ReactNode {
	const tlRich = useRichLiteralMessages();
	if (actions.length === 0) {
		return null;
	}
	const tags: Record<string, (children: ReactNode) => ReactNode> = {};
	for (const action of actions) {
		const tag = TAG_BY_LABEL[action.label];
		if (tag) {
			tags[tag] = (children) => (
				<button
					className={cn(TEXT_BUTTON, "text-primary")}
					onClick={action.onClick}
					type="button"
				>
					{children}
				</button>
			);
		}
	}
	const shape = actions.map((action) => TAG_BY_LABEL[action.label]).join("+");
	switch (shape) {
		case "browse+latest":
			return tlRich(
				"<browse>Browse all categories</browse> or <latest>view latest topics</latest>.",
				{},
				tags
			);
		case "browse":
			return tlRich("<browse>Browse all categories</browse>.", {}, tags);
		case "latest":
			return tlRich("<latest>View latest topics</latest>.", {}, tags);
		case "clear":
			return tlRich("<clear>Clear search</clear>.", {}, tags);
		default:
			return actions.map((action, index) => (
				<span key={action.label}>
					{index === 0 ? null : " "}
					<button
						className={cn(TEXT_BUTTON, "text-primary")}
						onClick={action.onClick}
						type="button"
					>
						{action.label}
					</button>
					.
				</span>
			));
	}
}
