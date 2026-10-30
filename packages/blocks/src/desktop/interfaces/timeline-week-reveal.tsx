import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { ChevronLeft, ChevronRight } from "lucide-react";

/** How many week days are scrolled out of view on either side. */
export interface HiddenDays {
	after: number;
	before: number;
}

/** The week gutter's buttons that scroll hidden days back into view. */
export function TimelineWeekReveal({
	hidden,
	onReveal,
}: {
	hidden: HiddenDays;
	onReveal: (side: "before" | "after") => void;
}) {
	const tl = useLiteralMessages();
	return (
		<>
			{hidden.before > 0 ? (
				<Button
					aria-label={tl(
						"Show {dayCount, plural, one {# day} other {# days}} earlier",
						{ dayCount: hidden.before }
					)}
					className="px-1.5 tabular-nums"
					onClick={() => onReveal("before")}
					size="xs"
					title={tl("{dayCount, plural, one {# day} other {# days}} earlier", {
						dayCount: hidden.before,
					})}
					type="button"
					variant="ghost-muted"
				>
					<ChevronLeft aria-hidden="true" data-icon="inline-start" />
					{hidden.before}
				</Button>
			) : null}
			{hidden.after > 0 ? (
				<Button
					aria-label={tl(
						"Show {dayCount, plural, one {# day} other {# days}} later",
						{ dayCount: hidden.after }
					)}
					className="px-1.5 tabular-nums"
					onClick={() => onReveal("after")}
					size="xs"
					title={tl("{dayCount, plural, one {# day} other {# days}} later", {
						dayCount: hidden.after,
					})}
					type="button"
					variant="ghost-muted"
				>
					{hidden.after}
					<ChevronRight aria-hidden="true" data-icon="inline-end" />
				</Button>
			) : null}
		</>
	);
}
