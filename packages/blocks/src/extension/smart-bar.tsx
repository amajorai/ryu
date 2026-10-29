"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import {
	ArrowUpRight,
	AtSign,
	Bookmark,
	Globe,
	MessageSquare,
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

const INTENT_ICON = {
	navigate: Globe,
	search: Search,
	ai: Sparkles,
	bang: ArrowUpRight,
	skill: TerminalSquare,
	mention: AtSign,
} satisfies Record<SmartIntent["kind"], typeof Globe>;

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
	const SuggestionGlyph = kind === "bookmark" ? Bookmark : MessageSquare;
	return (
		<SuggestionGlyph
			aria-hidden="true"
			className="size-4 shrink-0 text-muted-foreground"
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

	const ActiveIcon = INTENT_ICON[active.kind];

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

	return (
		<div className="w-full">
			<div
				className={
					embedded
						? "flex items-center gap-3 rounded-2xl bg-muted px-3 py-3 focus-within:ring-1 focus-within:ring-primary/30"
						: "flex items-center gap-3 rounded-2xl border bg-card px-4 py-3 shadow-sm focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/30"
				}
			>
				<ActiveIcon className="size-5 shrink-0 text-muted-foreground" />
				<input
					aria-activedescendant={
						activeSuggestionIndex >= 0
							? `${suggestionsId}-${activeSuggestionIndex}`
							: undefined
					}
					aria-controls={suggestions.length > 0 ? suggestionsId : undefined}
					aria-label={PLACEHOLDER}
					autoFocus={autoFocus}
					className="flex-1 bg-transparent text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
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

			{hasInput && suggestionStatus !== "idle" ? (
				<div
					aria-label="Local Ryu results"
					className="mt-2 overflow-hidden rounded-xl border border-border/70 bg-card shadow-sm"
					id={suggestionsId}
					role="listbox"
				>
					<div className="type-caption flex items-center justify-between border-border/60 border-b px-3 py-2 text-muted-foreground">
						<span className="font-medium uppercase tracking-wider">
							Local Ryu results
						</span>
						<span aria-live="polite">
							{suggestionStatus === "loading"
								? "Searching…"
								: suggestions.length > 0
									? tl("{matchCount} found", {
											matchCount: String(suggestions.length),
										})
									: "No matches"}
						</span>
					</div>
					{suggestions.length > 0 ? (
						<div className="p-1">
							{suggestions.map((suggestion, index) => (
								<button
									aria-selected={index === activeSuggestionIndex}
									className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted ${
										index === activeSuggestionIndex ? "bg-muted" : ""
									}`}
									id={`${suggestionsId}-${index}`}
									key={suggestion.id}
									onClick={() => onSelectSuggestion?.(suggestion)}
									onMouseEnter={() => setSuggestionIndex(index)}
									role="option"
									type="button"
								>
									<SuggestionIcon kind={suggestion.kind} />
									<span className="min-w-0 flex-1">
										<span className="block truncate font-medium text-foreground text-sm">
											{suggestion.title}
										</span>
										<span className="block truncate text-muted-foreground text-xs">
											{suggestion.description}
										</span>
									</span>
								</button>
							))}
						</div>
					) : null}
				</div>
			) : null}

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
