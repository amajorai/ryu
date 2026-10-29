import { installHorizontalWheelScrolling } from "@ryu/ui/lib/horizontal-wheel-scroll.ts";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

const ROWS = [
	{ accent: "bg-sky-500/15", label: "Chat", note: "Keep the thread moving" },
	{
		accent: "bg-violet-500/15",
		label: "Agents",
		note: "Choose the right runtime",
	},
	{ accent: "bg-warning/15", label: "Spaces", note: "Search your context" },
	{
		accent: "bg-success/15",
		label: "Workflows",
		note: "Automate the handoff",
	},
	{
		accent: "bg-rose-500/15",
		label: "Marketplace",
		note: "Extend the workspace",
	},
	{
		accent: "bg-cyan-500/15",
		label: "Calendar",
		note: "Keep the schedule close",
	},
	{ accent: "bg-warning/15", label: "Approvals", note: "Stay in control" },
	{
		accent: "bg-indigo-500/15",
		label: "Analytics",
		note: "See what is working",
	},
	{ accent: "bg-lime-500/15", label: "Tools", note: "Connect the useful bits" },
] as const;

function HorizontalWheelScrollProof() {
	const horizontalRef = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState({ left: 0, max: 0 });

	useEffect(() => {
		const element = horizontalRef.current;
		if (!element) {
			return;
		}
		const updatePosition = () => {
			setPosition({
				left: Math.round(element.scrollLeft),
				max: Math.max(0, Math.round(element.scrollWidth - element.clientWidth)),
			});
		};
		updatePosition();
		element.addEventListener("scroll", updatePosition, { passive: true });
		return () => element.removeEventListener("scroll", updatePosition);
	}, []);

	return (
		<main className="min-h-screen bg-background px-6 py-10 text-foreground sm:px-10">
			<section className="mx-auto flex max-w-4xl flex-col gap-8">
				<header className="max-w-2xl">
					<p className="mb-3 font-mono text-muted-foreground text-xs uppercase tracking-widest">
						Interaction proof
					</p>
					<h1 className="font-semibold text-3xl tracking-tight sm:text-4xl">
						Scroll horizontal rows with the mouse wheel
					</h1>
					<p className="mt-4 text-muted-foreground text-sm leading-6 sm:text-base">
						The row below has horizontal overflow but no vertical overflow. Roll
						up or down over it to move left and right; trackpad swipes still
						work.
					</p>
				</header>

				<div className="rounded-3xl border border-border/70 bg-card/70 p-4 shadow-sm sm:p-6">
					<div
						className="scrollbar-hide flex max-w-full gap-3 overflow-x-auto overflow-y-hidden overscroll-x-contain rounded-2xl border border-border/60 bg-muted/20 p-3"
						data-testid="horizontal-wheel-proof"
						ref={horizontalRef}
					>
						{ROWS.map((row) => (
							<article
								className={`flex w-52 shrink-0 flex-col justify-between gap-8 rounded-xl border border-border/60 p-4 ${row.accent}`}
								key={row.label}
							>
								<div>
									<p className="font-medium text-sm">{row.label}</p>
									<p className="mt-1 text-muted-foreground text-xs">
										{row.note}
									</p>
								</div>
								<span className="type-compact font-mono text-muted-foreground uppercase tracking-(--tracking-section)">
									Ryu surface
								</span>
							</article>
						))}
					</div>
					<div className="mt-4 flex items-center justify-between gap-4 text-muted-foreground text-xs">
						<span data-testid="horizontal-wheel-position">
							Scroll position: {position.left}px / {position.max}px
						</span>
						<span className="font-mono uppercase tracking-(--tracking-section)">
							Wheel → horizontal
						</span>
					</div>
				</div>

				<div className="grid gap-4 sm:grid-cols-2">
					<div className="rounded-2xl border border-border/60 bg-card/50 p-5">
						<p className="font-medium text-sm">The rule</p>
						<p className="mt-2 text-muted-foreground text-sm leading-6">
							Only horizontal-only containers receive the translation. A
							container that also has vertical overflow keeps normal wheel
							behavior.
						</p>
					</div>
					<div className="rounded-2xl border border-border/60 bg-card/50 p-5">
						<p className="font-medium text-sm">The edge</p>
						<p className="mt-2 text-muted-foreground text-sm leading-6">
							When the row reaches an edge, the event stays native so the
							surrounding page can continue scrolling.
						</p>
					</div>
				</div>

				<div
					className="h-24 overflow-auto rounded-2xl border border-border/60 bg-card/40 p-4 text-muted-foreground text-sm"
					data-testid="vertical-wheel-proof"
				>
					<p className="font-medium text-foreground">Vertical-scroll control</p>
					<p className="mt-2 leading-6">
						This intentionally has vertical overflow. Its wheel movement remains
						vertical so the horizontal adapter does not hijack it.
					</p>
					<p className="mt-2 leading-6">
						Ryu keeps interaction rules local to the container that can actually
						move.
					</p>
				</div>
			</section>
		</main>
	);
}

installHorizontalWheelScrolling(document);

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<HorizontalWheelScrollProof />);
}
