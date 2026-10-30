"use client";

import { ArrowUp02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useEffect, useState } from "react";

export function usePrefersReducedMotion(): boolean {
	const [reduced, setReduced] = useState(false);
	useEffect(() => {
		if (globalThis.window === undefined || !window.matchMedia) {
			return;
		}
		const query = window.matchMedia("(prefers-reduced-motion: reduce)");
		setReduced(query.matches);
		const onChange = () => setReduced(query.matches);
		query.addEventListener("change", onChange);
		return () => query.removeEventListener("change", onChange);
	}, []);
	return reduced;
}

export function Crumbs({
	items,
	onBack,
}: {
	items: string[];
	onBack: () => void;
}) {
	return (
		<nav aria-label="Thread location" className="min-w-0">
			<ol className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-sm">
				{items.map((item, index) => {
					const last = index === items.length - 1;
					return (
						<li className="flex min-w-0 items-center gap-1.5" key={item}>
							{index > 0 ? <span aria-hidden="true">›</span> : null}
							{last ? (
								<span className="truncate text-foreground">{item}</span>
							) : (
								<button
									className="truncate transition-colors hover:text-foreground"
									onClick={onBack}
									type="button"
								>
									{item}
								</button>
							)}
						</li>
					);
				})}
			</ol>
		</nav>
	);
}

export function UserBubble({ children }: { children: ReactNode }) {
	return (
		<div className="flex justify-end">
			<p className="max-w-[80%] rounded-2xl bg-muted px-4 py-2 text-sm">
				{children}
			</p>
		</div>
	);
}

export function AssistantText({ children }: { children: ReactNode }) {
	return <p className="text-sm leading-relaxed">{children}</p>;
}

export function Composer({ placeholder }: { placeholder: string }) {
	return (
		<div className="mx-4 mb-4 flex items-center gap-2 rounded-3xl border border-border bg-card px-4 py-2.5 shadow-sm">
			<span className="min-w-0 flex-1 truncate text-muted-foreground text-sm">
				{placeholder}
			</span>
			<span className="flex size-7 items-center justify-center rounded-full bg-foreground text-background">
				<HugeiconsIcon className="size-4" icon={ArrowUp02Icon} />
			</span>
		</div>
	);
}

// Window frame, title bar and pane height of the demo window.
export const DEMO_FRAME_CLASS =
	"overflow-hidden rounded-2xl border border-border bg-background shadow-2xl";
export const DEMO_PANE_CLASS = "h-[660px] text-left";

export function DemoTitleBar({ title }: { title: string }) {
	return (
		<div className="flex items-center gap-1.5 border-border/60 border-b bg-muted/40 px-3 py-2">
			<span className="size-2.5 rounded-full bg-foreground/15" />
			<span className="size-2.5 rounded-full bg-foreground/15" />
			<span className="size-2.5 rounded-full bg-foreground/15" />
			<span className="ml-3 truncate font-medium text-muted-foreground text-xs">
				{title}
			</span>
		</div>
	);
}
