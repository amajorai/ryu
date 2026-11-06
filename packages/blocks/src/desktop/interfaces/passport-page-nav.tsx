import { useLiteralMessages } from "@ryu/i18n/react";
import { useDirection } from "@ryu/ui/components/direction.tsx";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { GameIconButton } from "./game-hud.tsx";

/**
 * The booklet sheet's page controls: previous, the caption, next. The paging
 * keys follow the reading direction (see `usePassportKeys`), so under
 * `dir="rtl"` the → key turns back and the ← key turns forward, and the
 * tooltips name the key that actually does it.
 */
export function PassportPageNav({
	caption,
	canNext,
	canPrevious,
	next,
	previous,
}: {
	caption: string;
	canNext: boolean;
	canPrevious: boolean;
	next: () => void;
	previous: () => void;
}) {
	const tl = useLiteralMessages();
	const rtl = useDirection() === "rtl";
	return (
		<nav
			aria-label={tl("Pages")}
			className="flex items-center justify-between gap-2"
		>
			<GameIconButton
				disabled={!canPrevious}
				label={tl("Previous page")}
				onClick={previous}
				title={rtl ? tl("Previous page (→)") : tl("Previous page (←)")}
			>
				<ChevronLeft
					aria-hidden="true"
					className="size-5 rtl:-scale-x-100"
					strokeWidth={2.75}
				/>
			</GameIconButton>
			<p
				aria-live="polite"
				className="gk-display min-w-36 text-center text-[16px] tabular-nums"
			>
				{caption}
			</p>
			<GameIconButton
				disabled={!canNext}
				label={tl("Next page")}
				onClick={next}
				title={rtl ? tl("Next page (←)") : tl("Next page (→)")}
			>
				<ChevronRight
					aria-hidden="true"
					className="size-5 rtl:-scale-x-100"
					strokeWidth={2.75}
				/>
			</GameIconButton>
		</nav>
	);
}
