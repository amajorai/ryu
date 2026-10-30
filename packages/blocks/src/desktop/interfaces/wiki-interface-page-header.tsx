import { cn } from "@ryu/ui/lib/utils";
import type { RefObject } from "react";

// ---------------------------------------------------------------------------
// Page header: title, Article / Talk, Read / View history, tagline
// ---------------------------------------------------------------------------

export interface TabSpec {
	id: string;
	label: string;
	onSelect: () => void;
	selected: boolean;
}

function TabButton({ tab }: { tab: TabSpec }) {
	return (
		<li>
			<button
				aria-current={tab.selected ? "page" : undefined}
				className={cn(
					"relative h-10 cursor-pointer rounded-t-[2px] px-2 text-sm outline-none transition-colors after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
					tab.selected
						? "text-foreground after:bg-foreground"
						: "text-primary hover:after:bg-border"
				)}
				onClick={tab.onSelect}
				type="button"
			>
				{tab.label}
			</button>
		</li>
	);
}

export function PageHeader({
	heading,
	headingRef,
	hideTitle,
	leftTabs,
	rightTabs,
	tagline,
}: {
	heading: string;
	headingRef: RefObject<HTMLHeadingElement | null>;
	hideTitle?: boolean;
	leftTabs: TabSpec[];
	rightTabs: TabSpec[];
	tagline: boolean;
}) {
	return (
		<header className="shrink-0">
			{hideTitle ? (
				<h1 className="sr-only" ref={headingRef} tabIndex={-1}>
					{heading}
				</h1>
			) : (
				<h1
					className="border-border border-b pt-6 pb-1 font-normal font-serif text-[28px] text-foreground leading-9 outline-none [overflow-wrap:anywhere]"
					ref={headingRef}
					tabIndex={-1}
				>
					{heading}
				</h1>
			)}
			<div
				className={cn(
					"flex items-end justify-between gap-4",
					hideTitle && "border-border border-b pt-2"
				)}
			>
				<nav aria-label="Namespaces">
					<ul className="-ml-2 flex">
						{leftTabs.map((tab) => (
							<TabButton key={tab.id} tab={tab} />
						))}
					</ul>
				</nav>
				{rightTabs.length > 0 ? (
					<nav aria-label="Views">
						<ul className="-mr-2 flex">
							{rightTabs.map((tab) => (
								<TabButton key={tab.id} tab={tab} />
							))}
						</ul>
					</nav>
				) : null}
			</div>
			{tagline ? (
				<p className="mt-2 text-[13px] text-muted-foreground leading-5">
					From the workspace wiki
				</p>
			) : null}
		</header>
	);
}
