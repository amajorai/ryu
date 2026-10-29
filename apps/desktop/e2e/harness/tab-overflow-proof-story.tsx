import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ContextMenuOverflowButton } from "../../src/components/layout/context-menu-overflow-button.tsx";
import { OverflowTooltip } from "../../src/components/layout/overflow-tooltip.tsx";
import "../../src/index.css";

const LONG_TITLE =
	"A very long workspace tab title that stays clipped without hiding its actions";

type RowKind = "horizontal" | "vertical";

function TabProofRow({ kind }: { kind: RowKind }) {
	const rowRef = useRef<HTMLDivElement>(null);
	return (
		<ContextMenu>
			<ContextMenuTrigger>
				<div
					className="group/tab flex h-9 w-[300px] items-center gap-2 rounded-lg border bg-card px-2 shadow-sm"
					data-proof-row={kind}
					ref={rowRef}
				>
					<span
						aria-hidden
						className="size-4 shrink-0 rounded-full bg-primary/20"
					/>
					<OverflowTooltip
						className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-sm"
						fade
						text={LONG_TITLE}
					/>
					<ContextMenuOverflowButton label={`${kind} tab`} targetRef={rowRef} />
				</div>
			</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem>Pin tab</ContextMenuItem>
				<ContextMenuItem>Unload tab</ContextMenuItem>
				<ContextMenuSeparator />
				<ContextMenuItem>Duplicate tab</ContextMenuItem>
				<ContextMenuItem>Close tab</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

function ProofStory() {
	const [metrics, setMetrics] = useState({
		animation: false,
		mask: false,
		menu: false,
	});

	useEffect(() => {
		const read = () => {
			const title = document.querySelector<HTMLElement>(
				'span[data-slot="tooltip-trigger"]'
			);
			const inner = title?.firstElementChild;
			const menu = document.querySelector(
				'[data-slot="context-menu-content"] [role="menuitem"]'
			);
			setMetrics({
				animation: (inner?.getAnimations().length ?? 0) > 0,
				mask: title
					? getComputedStyle(title).maskImage.includes("linear-gradient")
					: false,
				menu: menu !== null,
			});
		};
		read();
		const observer = new MutationObserver(read);
		observer.observe(document.body, { childList: true, subtree: true });
		const timer = window.setInterval(read, 150);
		return () => {
			observer.disconnect();
			window.clearInterval(timer);
		};
	}, []);

	const verified = !metrics.animation && metrics.mask && metrics.menu;
	return (
		<main className="min-h-screen bg-background p-8 text-foreground">
			<div className="mx-auto flex max-w-2xl flex-col gap-6">
				<header className="flex items-start justify-between gap-4">
					<div>
						<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
							React verification artifact
						</p>
						<h1 className="font-semibold text-2xl">Tab title overflow</h1>
						<p className="mt-1 text-muted-foreground text-sm">
							The rows below use the shipping fade, static clipped title, and
							context menu trigger.
						</p>
					</div>
					<p
						className="rounded-full border px-3 py-1 font-medium text-xs"
						data-status={verified ? "pass" : "pending"}
						data-testid="proof-status"
					>
						{verified ? "PASS" : "HOVER A TITLE, THEN OPEN ⋯"}
					</p>
				</header>

				<section className="flex flex-col gap-3 rounded-xl border bg-card p-5">
					<div>
						<p className="font-medium text-sm">Horizontal tab strip</p>
						<p className="text-muted-foreground text-xs">
							Long titles reserve room for the hover actions.
						</p>
					</div>
					<TabProofRow kind="horizontal" />
					<div>
						<p className="font-medium text-sm">Vertical tab bar</p>
						<p className="text-muted-foreground text-xs">
							The same row affordance works in the sidebar layout.
						</p>
					</div>
					<TabProofRow kind="vertical" />
				</section>

				<dl className="grid gap-2 rounded-xl border bg-card p-4 text-sm sm:grid-cols-3">
					<div>
						<dt className="text-muted-foreground">Edge fade</dt>
						<dd data-testid="proof-mask">
							{metrics.mask ? "engaged" : "pending"}
						</dd>
					</div>
					<div>
						<dt className="text-muted-foreground">Legacy motion</dt>
						<dd data-testid="proof-animation">
							{metrics.animation ? "unexpected motion" : "static"}
						</dd>
					</div>
					<div>
						<dt className="text-muted-foreground">Shared menu</dt>
						<dd data-testid="proof-menu">
							{metrics.menu ? "open" : "pending"}
						</dd>
					</div>
				</dl>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<ProofStory />);
}
