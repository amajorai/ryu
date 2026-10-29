import { Button } from "@ryu/ui/components/button.tsx";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@ryu/ui/components/input-group.tsx";
import { Slider } from "@ryu/ui/components/slider.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import {
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/ui/components/toggle-group.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { ChevronRight, RotateCcw, Search, Settings2, X } from "lucide-react";
import {
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useCallback,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	displayLabel,
	KIND_LABELS,
	type KnowledgeNode,
	type KnowledgeSettings,
} from "./knowledge-model.ts";
import { HintButton } from "./knowledge-parts.tsx";

/**
 * The graph settings panel, after Obsidian's: collapsible Filters, Display
 * and Forces sections, a restore-defaults button and a close button that
 * folds it down to a single settings button.
 */

type SettingsPatch = Partial<KnowledgeSettings>;

type SectionKey = "display" | "filters" | "forces";

/** Below this scroll height (px), Display and Forces open one at a time. */
const SHORT_CARD = 640;
const SLIDER_SECTIONS: Partial<Record<SectionKey, SectionKey>> = {
	display: "forces",
	forces: "display",
};

const SLIDER =
	"[&_[data-slot=slider-thumb]]:size-3.5 [&_[data-slot=slider-thumb]]:rounded-full [&_[data-slot=slider-track]]:h-1";

function Section({
	children,
	onToggle,
	open,
	title,
}: {
	children: ReactNode;
	onToggle: () => void;
	open: boolean;
	title: string;
}) {
	const contentId = useId();
	return (
		<section className="border-border border-t first:border-t-0">
			<h4>
				<button
					aria-controls={contentId}
					aria-expanded={open}
					className="flex h-9 w-full items-center gap-1.5 px-3 text-left font-medium text-foreground text-sm outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
					onClick={onToggle}
					type="button"
				>
					<ChevronRight
						aria-hidden="true"
						className={cn(
							"size-3.5 text-foreground/55 transition-transform duration-150 motion-reduce:transition-none",
							open && "rotate-90"
						)}
					/>
					{title}
				</button>
			</h4>
			{open ? (
				<div className="flex flex-col gap-1 px-3 pt-0.5 pb-3" id={contentId}>
					{children}
				</div>
			) : null}
		</section>
	);
}

function ToggleRow({
	checked,
	inset = false,
	label,
	name,
	onChange,
}: {
	checked: boolean;
	/** A sub-option of the row above it. */
	inset?: boolean;
	label: string;
	name: string;
	onChange: (checked: boolean) => void;
}) {
	const id = useId();
	return (
		<div
			className={cn(
				"flex h-8 items-center justify-between gap-3",
				inset && "ms-1.5 border-border border-s ps-3"
			)}
		>
			<label className="min-w-0 truncate text-foreground text-sm" htmlFor={id}>
				{label}
			</label>
			<Switch
				aria-label={name}
				checked={checked}
				className="data-unchecked:bg-foreground/20"
				id={id}
				onCheckedChange={(next) => onChange(next)}
				size="sm"
			/>
		</div>
	);
}

function SliderRow({
	label,
	max,
	min,
	onChange,
	step,
	value,
}: {
	label: string;
	max: number;
	min: number;
	onChange: (value: number) => void;
	step: number;
	value: number;
}) {
	const id = useId();
	return (
		<div className="flex flex-col gap-2 py-1.5">
			<span className="text-foreground text-sm" id={id}>
				{label}
			</span>
			<Slider
				aria-labelledby={id}
				className={SLIDER}
				max={max}
				min={min}
				onValueChange={(next) => {
					const value = Array.isArray(next) ? next[0] : next;
					if (typeof value === "number") {
						onChange(value);
					}
				}}
				step={step}
				value={value}
			/>
		</div>
	);
}

/** Matches shown under the search field; the rest are counted. */
const MAX_RESULTS = 6;

/** A result's name with the matched part set in the foreground. */
function Highlighted({ query, text }: { query: string; text: string }) {
	const needle = query.trim().toLowerCase();
	const at = needle ? text.toLowerCase().indexOf(needle) : -1;
	if (at < 0) {
		return <>{text}</>;
	}
	return (
		<>
			{text.slice(0, at)}
			<mark className="bg-transparent font-medium text-foreground">
				{text.slice(at, at + needle.length)}
			</mark>
			{text.slice(at + needle.length)}
		</>
	);
}

const RESULTS_SURFACE =
	"mt-1 rounded-md border border-border bg-background/70 p-1";

/**
 * Search hits, inline under the field (the settings below move down rather
 * than being covered), reachable by name: Arrow Down from the field moves
 * into the list.
 */
function SearchResults({
	listRef,
	onPick,
	query,
	results,
	searchRef,
}: {
	listRef: RefObject<HTMLUListElement | null>;
	onPick: (id: string) => void;
	query: string;
	results: readonly KnowledgeNode[];
	searchRef: RefObject<HTMLInputElement | null>;
}) {
	if (results.length === 0) {
		return (
			<p
				className={cn(
					RESULTS_SURFACE,
					"flex h-9 items-center px-2 text-muted-foreground text-xs"
				)}
			>
				No matching nodes
			</p>
		);
	}
	const move = (event: KeyboardEvent<HTMLButtonElement>, step: 1 | -1) => {
		event.preventDefault();
		const buttons = [
			...(listRef.current?.querySelectorAll("button") ?? []),
		] as HTMLButtonElement[];
		const index = buttons.indexOf(event.currentTarget);
		const next = buttons[index + step];
		if (next) {
			next.focus();
		} else if (step === -1) {
			searchRef.current?.focus();
		}
	};
	const extra = results.length - MAX_RESULTS;
	return (
		<ul
			aria-label="Matching nodes"
			className={cn(RESULTS_SURFACE, "flex flex-col")}
			ref={listRef}
		>
			{results.slice(0, MAX_RESULTS).map((node) => (
				<li key={node.id}>
					<button
						className="flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
						onClick={() => onPick(node.id)}
						onKeyDown={(event) => {
							if (event.key === "ArrowDown") {
								move(event, 1);
							} else if (event.key === "ArrowUp") {
								move(event, -1);
							}
						}}
						type="button"
					>
						<span className="min-w-0 flex-1 truncate text-foreground/80 text-sm">
							<Highlighted query={query} text={displayLabel(node)} />
						</span>
						<span className="shrink-0 text-muted-foreground text-xs">
							{KIND_LABELS[node.kind]}
						</span>
					</button>
				</li>
			))}
			{extra > 0 ? (
				<li className="flex h-6 items-center px-2 text-muted-foreground text-xs tabular-nums">
					{extra} more
				</li>
			) : null}
		</ul>
	);
}

export function KnowledgeControls({
	hasSelection,
	onAnimate,
	onChange,
	onClose,
	onPick,
	onQueryChange,
	onQuerySubmit,
	onReset,
	query,
	results,
	searchRef,
	settings,
	topicCount,
}: {
	hasSelection: boolean;
	onAnimate: () => void;
	onChange: (patch: SettingsPatch) => void;
	onClose: () => void;
	onPick: (id: string) => void;
	onQueryChange: (query: string) => void;
	onQuerySubmit: () => void;
	onReset: () => void;
	query: string;
	results: readonly KnowledgeNode[];
	searchRef: RefObject<HTMLInputElement | null>;
	settings: KnowledgeSettings;
	/** Topics in the workspace graph (before filters). */
	topicCount: number;
}) {
	const listRef = useRef<HTMLUListElement>(null);
	const matchCount = results.length;
	const local = settings.mode === "local";
	const countId = useId();
	const depthId = useId();
	const scrollRef = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState<Record<SectionKey, boolean>>({
		display: false,
		filters: true,
		forces: true,
	});
	const [moreBelow, setMoreBelow] = useState(false);
	const measure = useCallback(() => {
		const element = scrollRef.current;
		if (element) {
			setMoreBelow(
				element.scrollTop + element.clientHeight < element.scrollHeight - 2
			);
		}
	}, []);
	useLayoutEffect(() => {
		measure();
	});
	const toggle = (key: SectionKey) => {
		setOpen((current) => {
			const next = { ...current, [key]: !current[key] };
			// On a short stage Display and Forces take turns, so opening one
			// never leaves the other's sliders cut off below the fold.
			const height = scrollRef.current?.clientHeight ?? 0;
			if (next[key] && height > 0 && height < SHORT_CARD) {
				const other = SLIDER_SECTIONS[key];
				if (other) {
					next[other] = false;
				}
			}
			return next;
		});
	};
	return (
		<div
			aria-label="Graph settings"
			className="pointer-events-auto flex max-h-full w-64 flex-col overflow-hidden rounded-lg border border-border bg-background/95 text-foreground shadow-sm"
			data-knowledge-chrome=""
			role="region"
		>
			<div className="flex h-10 shrink-0 items-center justify-between gap-2 border-border border-b ps-3 pe-1.5">
				<h3 className="font-medium text-foreground text-sm">Graph settings</h3>
				<div className="flex items-center gap-0.5">
					<HintButton
						className="text-foreground/70"
						label="Restore default settings"
						onClick={onReset}
						side="bottom"
						size="icon-xs"
					>
						<RotateCcw aria-hidden="true" className="size-3.5" />
					</HintButton>
					<HintButton
						className="text-foreground/70"
						label="Close graph settings"
						onClick={onClose}
						side="bottom"
						size="icon-xs"
					>
						<X aria-hidden="true" className="size-3.5" />
					</HintButton>
				</div>
			</div>
			<div
				className={cn(
					"min-h-0 flex-1 overflow-y-auto overscroll-contain",
					moreBelow &&
						"[mask-image:linear-gradient(to_bottom,black_calc(100%-16px),transparent)]"
				)}
				data-knowledge-more={moreBelow ? "" : undefined}
				onScroll={measure}
				ref={scrollRef}
			>
				<Section
					onToggle={() => toggle("filters")}
					open={open.filters}
					title="Filters"
				>
					<form
						className="pb-1"
						onSubmit={(event) => {
							event.preventDefault();
							onQuerySubmit();
						}}
						role="search"
					>
						<InputGroup className="h-8 rounded-md border-border bg-background/70">
							<InputGroupAddon className="ps-2.5 text-foreground/55">
								<Search aria-hidden="true" className="size-3.5" />
							</InputGroupAddon>
							<InputGroupInput
								aria-describedby={query ? countId : undefined}
								aria-label="Search the graph"
								className="h-8 text-sm placeholder:text-foreground/55 [&::-webkit-search-cancel-button]:appearance-none"
								onChange={(event) => onQueryChange(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "ArrowDown" && query) {
										event.preventDefault();
										listRef.current?.querySelector("button")?.focus();
									} else if (event.key === "Escape" && query) {
										event.preventDefault();
										onQueryChange("");
									}
								}}
								placeholder="Search nodes"
								ref={searchRef}
								type="search"
								value={query}
							/>
							{query ? (
								<InputGroupAddon align="inline-end" className="gap-1 pe-1.5">
									<span
										className="text-muted-foreground text-xs tabular-nums"
										id={countId}
									>
										{matchCount}
									</span>
									<InputGroupButton
										aria-label="Clear search"
										onClick={() => onQueryChange("")}
										size="icon-xs"
									>
										<X aria-hidden="true" />
									</InputGroupButton>
								</InputGroupAddon>
							) : null}
						</InputGroup>
						{query.trim() ? (
							<SearchResults
								listRef={listRef}
								onPick={onPick}
								query={query}
								results={results}
								searchRef={searchRef}
							/>
						) : null}
					</form>
					<ToggleRow
						checked={local}
						label="Local graph"
						name="Local graph"
						onChange={(checked) =>
							onChange({ mode: checked ? "local" : "global" })
						}
					/>
					{local ? (
						hasSelection ? (
							<div className="flex h-8 items-center justify-between gap-3">
								<span className="text-foreground text-sm" id={depthId}>
									Depth
								</span>
								<ToggleGroup
									appearance="segmented"
									aria-labelledby={depthId}
									className="bg-transparent ring-1 ring-border ring-inset"
									multiple={false}
									onValueChange={(values: string[]) => {
										const value = values[0];
										if (value === "1" || value === "2") {
											onChange({ depth: value === "2" ? 2 : 1 });
										}
									}}
									spacing={0}
									value={[String(settings.depth)]}
								>
									{(["1", "2"] as const).map((depth) => (
										<ToggleGroupItem
											aria-label={`Depth ${depth}`}
											className="h-6 min-w-8 px-2 text-foreground/70 tabular-nums opacity-100 hover:text-foreground aria-pressed:bg-muted aria-pressed:font-medium aria-pressed:text-foreground aria-pressed:shadow-none"
											density="segmented"
											key={depth}
											value={depth}
										>
											{depth}
										</ToggleGroupItem>
									))}
								</ToggleGroup>
							</div>
						) : (
							<p className="-mt-1 pb-1 text-foreground/70 text-xs leading-5">
								Select a node to centre on.
							</p>
						)
					) : null}
					<ToggleRow
						checked={settings.agents}
						label="Agents"
						name="Show agents"
						onChange={(agents) => onChange({ agents })}
					/>
					<ToggleRow
						checked={settings.groups}
						label="Projects and teams"
						name="Show projects and teams"
						onChange={(groups) => onChange({ groups })}
					/>
					<ToggleRow
						checked={settings.conversations}
						label="Conversations"
						name="Show conversations"
						onChange={(conversations) => onChange({ conversations })}
					/>
					<ToggleRow
						checked={settings.topics}
						label="Topics"
						name="Show topics"
						onChange={(topics) => onChange({ topics })}
					/>
					{settings.topics ? (
						<ToggleRow
							checked={settings.messages}
							inset
							label="Include latest messages"
							name="Include latest messages in topics"
							onChange={(messages) => onChange({ messages })}
						/>
					) : null}
					{settings.topics && topicCount === 0 ? (
						<p className="pb-1 text-foreground/70 text-xs leading-5">
							{settings.messages
								? "No word appears in two conversations or their latest messages."
								: "No title word appears in two conversations yet."}
						</p>
					) : null}
					<ToggleRow
						checked={settings.orphans}
						label="Orphans"
						name="Show orphans"
						onChange={(orphans) => onChange({ orphans })}
					/>
				</Section>
				<Section
					onToggle={() => toggle("display")}
					open={open.display}
					title="Display"
				>
					<SliderRow
						label="Text fade threshold"
						max={1}
						min={0}
						onChange={(textFade) => onChange({ textFade })}
						step={0.05}
						value={settings.textFade}
					/>
					<SliderRow
						label="Node size"
						max={2}
						min={0.5}
						onChange={(nodeSize) => onChange({ nodeSize })}
						step={0.05}
						value={settings.nodeSize}
					/>
					<SliderRow
						label="Link thickness"
						max={4}
						min={0.5}
						onChange={(linkWidth) => onChange({ linkWidth })}
						step={0.25}
						value={settings.linkWidth}
					/>
					<Button
						className="mt-2 w-full"
						onClick={onAnimate}
						size="sm"
						type="button"
						variant="outline"
					>
						Animate
					</Button>
				</Section>
				<Section
					onToggle={() => toggle("forces")}
					open={open.forces}
					title="Forces"
				>
					<SliderRow
						label="Center force"
						max={1}
						min={0}
						onChange={(centerForce) => onChange({ centerForce })}
						step={0.02}
						value={settings.centerForce}
					/>
					<SliderRow
						label="Repel force"
						max={1}
						min={0}
						onChange={(repelForce) => onChange({ repelForce })}
						step={0.02}
						value={settings.repelForce}
					/>
					<SliderRow
						label="Link force"
						max={1}
						min={0}
						onChange={(linkForce) => onChange({ linkForce })}
						step={0.02}
						value={settings.linkForce}
					/>
					<SliderRow
						label="Link distance"
						max={120}
						min={12}
						onChange={(linkDistance) => onChange({ linkDistance })}
						step={1}
						value={settings.linkDistance}
					/>
				</Section>
			</div>
		</div>
	);
}

/** The folded state: one button that reopens the panel. */
export function KnowledgeControlsButton({ onOpen }: { onOpen: () => void }) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						aria-label="Open graph settings"
						className="pointer-events-auto bg-background/95 shadow-sm"
						data-knowledge-chrome=""
						onClick={onOpen}
						size="icon-sm"
						type="button"
						variant="outline"
					/>
				}
			>
				<Settings2 aria-hidden="true" className="size-4" />
			</TooltipTrigger>
			<TooltipContent side="left">Graph settings</TooltipContent>
		</Tooltip>
	);
}
