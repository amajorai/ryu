import { cn } from "@ryu/ui/lib/utils";
import type { CSSProperties } from "react";
import { HUB_CARD_LABELS, HUB_CARDS } from "./hub-model.ts";

interface HubStyle extends CSSProperties {
	"--hub-card": string;
	"--hub-card-h": string;
	"--hub-card-wide": string;
	"--hub-gutter": string;
}

export const HUB_STYLE: HubStyle = {
	"--hub-card": "min(calc(100cqw - 3rem), clamp(20rem, 29cqw, 26rem))",
	// One height for every card: the room under the header and above the
	// dots, capped so a tall screen does not stretch the cards into posters.
	"--hub-card-h": "clamp(17rem, calc(100cqh - 14rem), 34rem)",
	// The last card fills what the card before it leaves, so at the end of the
	// row both rest between the gutters and nothing is clipped.
	"--hub-card-wide":
		"min(56rem, max(min(calc(100cqw - 3rem), clamp(20rem, 40cqw, 36rem)), calc(100cqw - 2 * var(--hub-gutter) - var(--hub-card) - 1rem)))",
	"--hub-gutter": "clamp(1.5rem, 5cqw, 4.5rem)",
};

export function PageDots({
	active,
	hidden,
	onSelect,
}: {
	active: number;
	hidden: boolean;
	onSelect: (index: number) => void;
}) {
	return (
		<nav
			aria-label="Cards"
			className={cn(
				// The hit areas are 44px tall; pull the row up so the dots sit
				// about 32px under the cards.
				"-mt-3 flex items-center justify-center transition-opacity duration-200 motion-reduce:transition-none",
				hidden && "invisible opacity-0"
			)}
		>
			{HUB_CARDS.map((card, index) => {
				const current = index === active;
				return (
					<button
						aria-current={current ? "true" : undefined}
						aria-label={HUB_CARD_LABELS[card]}
						className="group flex h-11 items-center justify-center px-2 outline-none"
						key={card}
						onClick={() => onSelect(index)}
						title={HUB_CARD_LABELS[card]}
						type="button"
					>
						<span
							className={cn(
								"block h-2 rounded-full transition-[width,background-color] duration-300 group-focus-visible:ring-3 group-focus-visible:ring-ring/40 motion-reduce:transition-none",
								current
									? "w-6 bg-foreground"
									: "w-2 bg-foreground/25 group-hover:bg-foreground/45"
							)}
						/>
					</button>
				);
			})}
		</nav>
	);
}
