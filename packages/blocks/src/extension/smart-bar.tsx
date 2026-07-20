"use client";

import {
	ArrowUpRight,
	AtSign,
	Globe,
	Search,
	Sparkles,
	TerminalSquare,
} from "lucide-react";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import { route, type SmartIntent } from "./smart-bar-engine.ts";

// Re-export the pure routing engine so external consumers (the live extension
// and the storyboard) can reach it through this `.tsx` entry. The package
// export map only exposes `./extension/*.tsx`, so a bare `.ts` engine is not
// importable from outside the package: this block is the public door to it.
export * from "./smart-bar-engine.ts";

const INTENT_ICON: Record<SmartIntent["kind"], typeof Globe> = {
	navigate: Globe,
	search: Search,
	ai: Sparkles,
	bang: ArrowUpRight,
	skill: TerminalSquare,
	mention: AtSign,
};

const PLACEHOLDER = "Search, type a URL, or ask Ryu…";

function DestinationPill({
	active,
	intent,
}: {
	active: boolean;
	intent: SmartIntent;
}) {
	const Icon = INTENT_ICON[intent.kind];
	return (
		<span
			className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
				active
					? "border-primary/50 bg-primary/10 text-foreground"
					: "border-transparent bg-muted/40 text-muted-foreground"
			}`}
		>
			<Icon className="size-3" />
			{intent.label}
		</span>
	);
}

export interface SmartBarProps {
	/** Opt-in autofocus. Off by default so a grid of snapshots stays calm. */
	autoFocus?: boolean;
	/**
	 * Seed text. The live extension leaves this empty (the bar starts blank);
	 * the storyboard passes a per-state string so the pills are computed by the
	 * real `route()` engine rather than mocked.
	 */
	defaultValue?: string;
	/**
	 * Side-effecting executor (navigate / open chat). Optional so the block
	 * renders standalone; the live extension injects the browser `executeIntent`.
	 */
	onExecute?: (intent: SmartIntent) => void;
}

/**
 * The Dia-style smart bar, presentational. All routing is the pure `route()`
 * engine; the only browser coupling is the optional `onExecute` handler the
 * live extension supplies.
 */
export function SmartBar({
	defaultValue = "",
	autoFocus = false,
	onExecute,
}: SmartBarProps) {
	const [value, setValue] = useState(defaultValue);
	const [cycle, setCycle] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);

	const { primary, alternatives } = useMemo(() => route(value), [value]);
	const destinations = useMemo(
		() => [primary, ...alternatives],
		[primary, alternatives]
	);
	const activeIndex = Math.min(cycle, destinations.length - 1);
	const active = destinations[activeIndex] ?? primary;
	const hasInput = value.trim().length > 0;

	const ActiveIcon = INTENT_ICON[active.kind];

	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Tab" && destinations.length > 1) {
			e.preventDefault();
			setCycle((c) => (c + 1) % destinations.length);
			return;
		}
		if (e.key === "Enter") {
			e.preventDefault();
			if (hasInput) {
				onExecute?.(active);
			}
			return;
		}
		if (e.key === "Escape") {
			setValue("");
			setCycle(0);
		}
	};

	return (
		<div className="w-full">
			<div className="flex items-center gap-3 rounded-2xl border bg-card px-4 py-3 shadow-sm focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/30">
				<ActiveIcon className="size-5 shrink-0 text-muted-foreground" />
				<input
					aria-label={PLACEHOLDER}
					autoFocus={autoFocus}
					className="flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
					onChange={(e) => {
						setValue(e.target.value);
						setCycle(0);
					}}
					onKeyDown={onKeyDown}
					placeholder={PLACEHOLDER}
					ref={inputRef}
					type="text"
					value={value}
				/>
			</div>

			{hasInput ? (
				<div className="mt-3 flex flex-wrap items-center gap-2">
					{destinations.map((intent, i) => (
						<DestinationPill
							active={i === activeIndex}
							intent={intent}
							key={`${intent.kind}-${intent.label}`}
						/>
					))}
					<span className="ml-auto text-muted-foreground text-xs">
						<kbd className="rounded bg-muted px-1.5 py-0.5">↵</kbd>{" "}
						{active.label}
						{destinations.length > 1 ? (
							<>
								{"  ·  "}
								<kbd className="rounded bg-muted px-1.5 py-0.5">⇥</kbd> cycle
							</>
						) : null}
					</span>
				</div>
			) : (
				<div className="mt-3 flex items-center gap-3 text-muted-foreground text-xs">
					<span>
						<kbd className="rounded bg-muted px-1.5 py-0.5">/</kbd> skill
					</span>
					<span>
						<kbd className="rounded bg-muted px-1.5 py-0.5">@</kbd> context
					</span>
					<span>
						<kbd className="rounded bg-muted px-1.5 py-0.5">!</kbd> search
						engine
					</span>
				</div>
			)}
		</div>
	);
}
