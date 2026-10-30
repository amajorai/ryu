"use client";

import {
	ArrowUpRight01Icon,
	AtIcon,
	Bookmark01Icon,
	BubbleChatIcon,
	CommandLineIcon,
	Globe02Icon,
	Search01Icon,
	SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import { route, type SmartIntent } from "./smart-bar-engine.ts";

// Re-export the pure routing engine so external consumers (the live extension
// and the storyboard) can reach it through this `.tsx` entry. The package
// export map only exposes `./extension/*.tsx`, so a bare `.ts` engine is not
// importable from outside the package: this block is the public door to it.
export * from "./smart-bar-engine.ts";

const INTENT_ICON = {
	navigate: Globe02Icon,
	search: Search01Icon,
	ai: SparklesIcon,
	bang: ArrowUpRight01Icon,
	skill: CommandLineIcon,
	mention: AtIcon,
} satisfies Record<SmartIntent["kind"], IconSvgElement>;

const PLACEHOLDER = "Search, type a URL, or ask Ryu…";

function DestinationPill({
	active,
	intent,
}: {
	active: boolean;
	intent: SmartIntent;
}) {
	return (
		<span
			className={cn(
				"flex h-8 items-center gap-1.5 rounded-full px-3 text-detail transition-colors duration-150",
				active ? "bg-muted text-foreground" : "text-muted-foreground"
			)}
		>
			<HugeiconsIcon icon={INTENT_ICON[intent.kind]} size={14} />
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
	/** Match the desktop launchpad composer surface when embedded in a frame. */
	embedded?: boolean;
	/**
	 * Side-effecting executor (navigate / open chat). Optional so the block
	 * renders standalone; the live extension injects the browser `executeIntent`.
	 */
	onExecute?: (intent: SmartIntent) => void;
	/** Called when a local result is selected with click or Enter. */
	onSelectSuggestion?: (suggestion: SmartBarSuggestion) => void;
	/** Called when the user types so a host can query its local index. */
	onValueChange?: (value: string) => void;
	/** Indicates whether the local index is being queried or is ready. */
	suggestionStatus?: "idle" | "loading" | "ready";
	/** Local, already-authorized records to show below the route suggestions. */
	suggestions?: readonly SmartBarSuggestion[];
}

export interface SmartBarSuggestion {
	description: string;
	id: string;
	kind: "bookmark" | "conversation";
	title: string;
}

function SuggestionIcon({ kind }: { kind: SmartBarSuggestion["kind"] }) {
	return (
		<HugeiconsIcon
			aria-hidden="true"
			className="shrink-0 text-muted-foreground"
			icon={kind === "bookmark" ? Bookmark01Icon : BubbleChatIcon}
			size={16}
		/>
	);
}

/**
 * The Dia-style smart bar, presentational. All routing is the pure `route()`
 * engine; the only browser coupling is the optional `onExecute` handler the
 * live extension supplies.
 */
export function SmartBar({
	defaultValue = "",
	autoFocus = false,
	embedded = false,
	onExecute,
	onSelectSuggestion,
	onValueChange,
	suggestions = [],
	suggestionStatus = "idle",
}: SmartBarProps) {
	const tl = useLiteralMessages();
	const [value, setValue] = useState(defaultValue);
	const [cycle, setCycle] = useState(0);
	const [suggestionIndex, setSuggestionIndex] = useState(-1);
	const inputRef = useRef<HTMLInputElement>(null);

	const { primary, alternatives } = useMemo(() => route(value), [value]);
	const destinations = useMemo(
		() => [primary, ...alternatives],
		[primary, alternatives]
	);
	const activeIndex = Math.min(cycle, destinations.length - 1);
	const active = destinations[activeIndex] ?? primary;
	const hasInput = value.trim().length > 0;
	const activeSuggestionIndex =
		suggestions.length > 0 && suggestionIndex >= 0
			? Math.min(suggestionIndex, suggestions.length - 1)
			: -1;
	const activeSuggestion =
		activeSuggestionIndex >= 0 ? suggestions[activeSuggestionIndex] : undefined;
	const suggestionsId = "ryu-smart-bar-local-results";

	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "ArrowDown" && suggestions.length > 0) {
			e.preventDefault();
			setSuggestionIndex((index) =>
				index >= suggestions.length - 1 ? 0 : index + 1
			);
			return;
		}
		if (e.key === "ArrowUp" && suggestions.length > 0) {
			e.preventDefault();
			setSuggestionIndex((index) =>
				index <= 0 ? suggestions.length - 1 : index - 1
			);
			return;
		}
		if (e.key === "Tab" && destinations.length > 1) {
			e.preventDefault();
			setCycle((c) => (c + 1) % destinations.length);
			return;
		}
		if (e.key === "Enter") {
			e.preventDefault();
			if (activeSuggestion) {
				onSelectSuggestion?.(activeSuggestion);
				return;
			}
			if (hasInput) {
				onExecute?.(active);
			}
			return;
		}
		if (e.key === "Escape") {
			setValue("");
			setCycle(0);
			setSuggestionIndex(-1);
		}
	};

	const showSuggestions = hasInput && suggestions.length > 0;
	const searchStatus =
		hasInput && suggestionStatus !== "idle"
			? suggestionStatus === "loading"
				? "Searching…"
				: tl(
						"{matchCount, plural, one {# local result} other {# local results}}",
						{ matchCount: suggestions.length }
					)
			: "";

	return (
		<div className="relative w-full">
			<div
				className={
					embedded
						? "flex h-12 items-center gap-3 rounded-2xl bg-muted px-4"
						: "flex h-14 items-center gap-3 rounded-4xl border border-border bg-background px-5 shadow-xs transition-colors duration-150 focus-within:border-ring/50 dark:bg-card"
				}
			>
				<HugeiconsIcon
					className="shrink-0 text-muted-foreground"
					icon={INTENT_ICON[active.kind]}
					size={16}
				/>
				<input
					aria-activedescendant={
						activeSuggestionIndex >= 0
							? `${suggestionsId}-${activeSuggestionIndex}`
							: undefined
					}
					aria-controls={showSuggestions ? suggestionsId : undefined}
					aria-label={PLACEHOLDER}
					autoFocus={autoFocus}
					className="min-w-0 flex-1 bg-transparent text-comfortable caret-foreground outline-none placeholder:text-muted-foreground"
					onChange={(e) => {
						setValue(e.target.value);
						setCycle(0);
						setSuggestionIndex(-1);
						onValueChange?.(e.target.value);
					}}
					onKeyDown={onKeyDown}
					placeholder={PLACEHOLDER}
					ref={inputRef}
					type="text"
					value={value}
				/>
			</div>

			<span aria-live="polite" className="sr-only">
				{searchStatus}
			</span>

			{showSuggestions ? (
				<div
					aria-label="Local Ryu results"
					className="mt-2 flex flex-col rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-md"
					id={suggestionsId}
					role="listbox"
				>
					{suggestions.map((suggestion, index) => (
						<button
							aria-selected={index === activeSuggestionIndex}
							className={cn(
								"flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm",
								index === activeSuggestionIndex && "bg-accent"
							)}
							id={`${suggestionsId}-${index}`}
							key={suggestion.id}
							onClick={() => onSelectSuggestion?.(suggestion)}
							onMouseEnter={() => setSuggestionIndex(index)}
							role="option"
							type="button"
						>
							<SuggestionIcon kind={suggestion.kind} />
							<span className="min-w-0 shrink truncate text-foreground">
								{suggestion.title}
							</span>
							<span className="min-w-0 flex-1 truncate text-detail text-muted-foreground">
								{suggestion.description}
							</span>
						</button>
					))}
				</div>
			) : null}

			{hasInput && destinations.length > 1 ? (
				<div className="mt-3 flex flex-wrap items-center gap-1">
					{destinations.map((intent, i) => (
						<DestinationPill
							active={i === activeIndex}
							intent={intent}
							key={`${intent.kind}-${intent.label}`}
						/>
					))}
					<span className="ml-auto text-muted-foreground/70 text-xs">
						Tab to switch
					</span>
				</div>
			) : null}
		</div>
	);
}
