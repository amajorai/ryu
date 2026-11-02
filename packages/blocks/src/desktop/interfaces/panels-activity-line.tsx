import { useRichLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { ReactNode } from "react";
import type { PanelsActivity } from "./panels-model.ts";

/** One activity row's sentence: who did what, and where. */
export function ActivityLine({ item }: { item: PanelsActivity }) {
	const tlRich = useRichLiteralMessages();
	const isRun = item.kind === "finished" || item.kind === "failed";
	const values = {
		actor: item.actor,
		context: item.context ?? "",
		verb: item.verb,
	};
	const tags = {
		actor: (children: ReactNode) => (
			<span className="font-medium text-foreground">{children}</span>
		),
		context: (children: ReactNode) => (
			<span className="text-muted-foreground">{children}</span>
		),
		verb: (children: ReactNode) => (
			<span
				className={cn(
					item.kind === "failed" ? "text-destructive" : "text-foreground/80"
				)}
			>
				{children}
			</span>
		),
	};
	let line: ReactNode;
	if (!item.context) {
		line = tlRich("<actor>{actor}</actor> <verb>{verb}</verb>", values, tags);
	} else if (isRun) {
		line = tlRich(
			"<actor>{actor}</actor> <verb>{verb}</verb><context> · {context}</context>",
			values,
			tags
		);
	} else {
		line = tlRich(
			"<actor>{actor}</actor> <verb>{verb}</verb><context> in {context}</context>",
			values,
			tags
		);
	}
	return (
		<span className="min-w-0 flex-1 truncate text-sm" data-ryu-i18n="off">
			{line}
		</span>
	);
}
