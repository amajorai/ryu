import { Button } from "@ryu/ui/components/button.tsx";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@ryu/ui/components/input-group.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { Search, X } from "lucide-react";
import {
	type FormEvent,
	type KeyboardEvent,
	type RefObject,
	useRef,
} from "react";
import { QA_TABS, type QaTab } from "./qa-model.ts";
import { QA_ICON_BUTTON } from "./qa-parts.tsx";

export interface QaTopBarProps {
	onAsk: () => void;
	onQueryChange: (query: string) => void;
	onSubmitSearch: () => void;
	query: string;
	searchRef: RefObject<HTMLInputElement | null>;
}

/**
 * The site header: search on the left, aligned with the feed, and the one
 * primary action, Ask question, on the right.
 */
export function QaTopBar({
	onAsk,
	onQueryChange,
	onSubmitSearch,
	query,
	searchRef,
}: QaTopBarProps) {
	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		onSubmitSearch();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Escape" && query) {
			event.preventDefault();
			event.stopPropagation();
			onQueryChange("");
		}
	};
	return (
		<header className="shrink-0 border-border border-b">
			<div className="mx-auto flex h-14 w-full max-w-[1120px] items-center gap-3 @[640px]/qa:px-6 px-4">
				<form
					className="min-w-0 max-w-[560px] flex-1"
					onSubmit={submit}
					role="search"
				>
					<InputGroup className="h-9">
						<InputGroupAddon>
							<Search aria-hidden="true" className="size-4" strokeWidth={2} />
						</InputGroupAddon>
						<InputGroupInput
							aria-label="Search questions"
							autoComplete="off"
							onChange={(event) => onQueryChange(event.target.value)}
							onKeyDown={onKeyDown}
							placeholder="Search questions"
							ref={searchRef}
							type="search"
							value={query}
						/>
						<InputGroupAddon align="inline-end">
							{query ? (
								<button
									aria-label="Clear search"
									className={cn(QA_ICON_BUTTON, "-mr-1 size-6 rounded-full")}
									onClick={() => {
										onQueryChange("");
										searchRef.current?.focus();
									}}
									type="button"
								>
									<X aria-hidden="true" className="size-3.5" strokeWidth={2} />
								</button>
							) : (
								<Kbd className="@[640px]/qa:inline-flex hidden">/</Kbd>
							)}
						</InputGroupAddon>
					</InputGroup>
				</form>
				<span className="@[640px]/qa:block hidden flex-1" />
				<Button className="shrink-0" onClick={onAsk} size="sm">
					Ask question
				</Button>
			</div>
		</header>
	);
}

export interface QaTabsProps {
	counts: Record<QaTab, number>;
	idFor: (tab: QaTab) => string;
	onSelect: (tab: QaTab) => void;
	panelId: string;
	tab: QaTab;
}

/**
 * Stack Overflow's filter group: joined segments with a count each. Arrow
 * keys move between tabs and select as they go, per the WAI tabs pattern.
 */
export function QaTabs({ counts, idFor, onSelect, panelId, tab }: QaTabsProps) {
	const refs = useRef(new Map<QaTab, HTMLButtonElement>());
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const index = QA_TABS.findIndex((entry) => entry.id === tab);
		let next = -1;
		if (event.key === "ArrowRight") {
			next = (index + 1) % QA_TABS.length;
		} else if (event.key === "ArrowLeft") {
			next = (index - 1 + QA_TABS.length) % QA_TABS.length;
		} else if (event.key === "Home") {
			next = 0;
		} else if (event.key === "End") {
			next = QA_TABS.length - 1;
		}
		const target = QA_TABS[next];
		if (target) {
			event.preventDefault();
			event.stopPropagation();
			onSelect(target.id);
			refs.current.get(target.id)?.focus();
		}
	};
	return (
		<div
			aria-label="Filter questions"
			className="flex max-w-full items-center overflow-x-auto rounded-lg border border-border p-0.5"
			onKeyDown={onKeyDown}
			role="tablist"
		>
			{QA_TABS.map((entry) => {
				const selected = entry.id === tab;
				return (
					<button
						aria-controls={panelId}
						aria-selected={selected}
						className={cn(
							"flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md @[640px]/qa:px-2.5 px-2 text-sm outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-ring/50",
							selected
								? "bg-muted font-medium text-foreground"
								: "text-muted-foreground hover:text-foreground"
						)}
						id={idFor(entry.id)}
						key={entry.id}
						onClick={() => onSelect(entry.id)}
						ref={(element) => {
							if (element) {
								refs.current.set(entry.id, element);
							} else {
								refs.current.delete(entry.id);
							}
						}}
						role="tab"
						tabIndex={selected ? 0 : -1}
						type="button"
					>
						{entry.short === entry.label ? (
							entry.label
						) : (
							<>
								<span className="@[480px]/qa:hidden">{entry.short}</span>
								<span className="@[480px]/qa:inline hidden">{entry.label}</span>
							</>
						)}
						<span
							className={cn(
								"text-xs tabular-nums",
								entry.id === "attention" && counts.attention > 0
									? "text-status-destructive"
									: "text-muted-foreground"
							)}
						>
							{counts[entry.id]}
						</span>
					</button>
				);
			})}
		</div>
	);
}

export interface QaFeedHeadingProps {
	description: string | null;
	onClear: (() => void) | null;
	title: string;
}

/** The page title over the feed, with a way back when the feed is narrowed. */
export function QaFeedHeading({
	description,
	onClear,
	title,
}: QaFeedHeadingProps) {
	return (
		<div className="flex items-start gap-3">
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<h1 className="truncate font-semibold! text-2xl text-foreground leading-8 tracking-tight">
					{title}
				</h1>
				{description ? (
					<p className="max-w-[60ch] text-muted-foreground text-sm leading-6">
						{description}
					</p>
				) : null}
			</div>
			{onClear ? (
				<Button
					className="mt-0.5"
					onClick={onClear}
					size="sm"
					variant="ghost-muted"
				>
					All questions
				</Button>
			) : null}
		</div>
	);
}
