import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useIsPresent } from "motion/react";
import {
	type FormEvent,
	Fragment,
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useId,
} from "react";
import { FORUM_WRAP } from "./forum-header.tsx";
import {
	CATEGORY_SECTION_LABELS,
	categorySections,
	draftPrompt,
	type ForumCategory,
	type ForumDraft,
} from "./forum-model.ts";
import { CategorySwatch, ForumAvatar, ICON_BUTTON } from "./forum-parts.tsx";

const ANY_AGENT = "any";

const FIELD =
	"h-9 w-full min-w-0 rounded-full border border-transparent bg-input/50 px-4 text-foreground text-sm outline-none transition-[color,box-shadow,background-color] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30";

function PickerTrigger({
	children,
	className,
	label,
	value,
}: {
	children?: ReactNode;
	className?: string;
	label: string;
	value: string;
}) {
	return (
		<DropdownMenuTrigger
			aria-label={`${label}: ${value}`}
			render={
				<button
					className={cn(
						FIELD,
						"flex items-center gap-2 px-3.5 text-left aria-expanded:border-ring",
						className
					)}
					type="button"
				/>
			}
		>
			{children}
			<span className="min-w-0 flex-1 truncate">{value}</span>
			<ChevronDown
				aria-hidden="true"
				className="size-4 shrink-0 text-muted-foreground"
				strokeWidth={2}
			/>
		</DropdownMenuTrigger>
	);
}

export interface ForumComposerProps {
	agents: readonly InterfaceAgent[];
	categories: readonly ForumCategory[];
	draft: ForumDraft;
	minimized: boolean;
	onChange: (draft: ForumDraft) => void;
	onDiscard: () => void;
	onMinimize: (minimized: boolean) => void;
	onSubmit: () => void;
	titleRef: RefObject<HTMLInputElement | null>;
}

/**
 * Discourse's composer, docked to the bottom: title, category, who answers,
 * then the body. Creating sends title and body as the first message. Escape
 * tucks it away with the draft kept; Cancel discards.
 */
export function ForumComposer({
	agents,
	categories,
	draft,
	minimized,
	onChange,
	onDiscard,
	onMinimize,
	onSubmit,
	titleRef,
}: ForumComposerProps) {
	// While the dock animates out, the form stays on screen but is done.
	const present = useIsPresent();
	const headingId = useId();
	const titleId = useId();
	const bodyId = useId();
	const category = categories.find(
		(candidate) => candidate.id === draft.categoryId
	);
	const agent = agents.find((candidate) => candidate.id === draft.agentId);
	const ready = draftPrompt(draft).length > 0;
	const agentCategory = category?.kind === "agent";

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (ready) {
			onSubmit();
		}
	};

	const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			onMinimize(true);
			return;
		}
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			event.stopPropagation();
			if (ready) {
				onSubmit();
			}
		}
	};

	if (minimized) {
		return (
			<div className={cn(FORUM_WRAP, "flex h-12 items-center gap-2")}>
				<button
					className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm outline-none transition-colors duration-100 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
					onClick={() => onMinimize(false)}
					type="button"
				>
					<span className="shrink-0 font-semibold text-foreground">
						Create a new topic
					</span>
					{draft.title.trim() ? (
						<span className="truncate text-muted-foreground">
							{draft.title.trim()}
						</span>
					) : null}
				</button>
				<button
					aria-label="Expand composer"
					className={ICON_BUTTON}
					onClick={() => onMinimize(false)}
					type="button"
				>
					<ChevronUp aria-hidden="true" className="size-4" strokeWidth={2} />
				</button>
				<button
					aria-label="Discard draft"
					className={ICON_BUTTON}
					onClick={onDiscard}
					type="button"
				>
					<X aria-hidden="true" className="size-4" strokeWidth={2} />
				</button>
			</div>
		);
	}

	return (
		<form
			aria-labelledby={headingId}
			className={cn(FORUM_WRAP, "flex flex-col gap-3 pt-3 pb-4")}
			data-state={present ? "open" : "closing"}
			data-testid="forum-composer"
			inert={!present}
			onKeyDown={onKeyDown}
			onSubmit={submit}
		>
			<div className="flex h-8 items-center gap-1">
				<h2
					className="flex-1 font-medium text-foreground text-sm"
					id={headingId}
				>
					Create a new topic
				</h2>
				<button
					aria-label="Minimize composer"
					className={ICON_BUTTON}
					onClick={() => onMinimize(true)}
					type="button"
				>
					<ChevronDown aria-hidden="true" className="size-4" strokeWidth={2} />
				</button>
			</div>
			<div className="flex @min-[720px]:flex-row flex-col gap-2">
				<label className="sr-only" htmlFor={titleId}>
					Title
				</label>
				<input
					autoComplete="off"
					className={cn(FIELD, "@min-[720px]:flex-1")}
					id={titleId}
					maxLength={255}
					onChange={(event) =>
						onChange({ ...draft, title: event.target.value })
					}
					placeholder="Type title"
					ref={titleRef}
					value={draft.title}
				/>
				<div className="flex gap-2">
					<DropdownMenu>
						<PickerTrigger
							className="@min-[720px]:w-52 @min-[720px]:flex-none flex-1"
							label="Category"
							value={category?.name ?? "Uncategorized"}
						>
							{category ? <CategorySwatch category={category} /> : null}
						</PickerTrigger>
						<DropdownMenuContent className="w-60" drawerLabel="Category">
							<DropdownMenuRadioGroup
								onValueChange={(value: string) =>
									onChange({ ...draft, categoryId: value })
								}
								value={draft.categoryId}
							>
								{categorySections(categories).map((section, index) => (
									<Fragment key={section.kind}>
										{index > 0 ? <DropdownMenuSeparator /> : null}
										<DropdownMenuGroup>
											<DropdownMenuLabel>
												{CATEGORY_SECTION_LABELS[section.kind]}
											</DropdownMenuLabel>
											{section.categories.map((option) => (
												<DropdownMenuRadioItem
													key={option.id}
													value={option.id}
												>
													<CategorySwatch category={option} />
													<span className="truncate">{option.name}</span>
												</DropdownMenuRadioItem>
											))}
										</DropdownMenuGroup>
									</Fragment>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuContent>
					</DropdownMenu>
					{agents.length > 0 && !agentCategory ? (
						<DropdownMenu>
							<PickerTrigger
								className="@min-[720px]:w-40 @min-[720px]:flex-none flex-1"
								label="Agent"
								value={agent?.name ?? "Any agent"}
							>
								{agent ? <ForumAvatar agent={agent} size={16} /> : null}
							</PickerTrigger>
							<DropdownMenuContent className="w-56" drawerLabel="Agent">
								<DropdownMenuGroup>
									<DropdownMenuLabel>Who replies</DropdownMenuLabel>
									<DropdownMenuRadioGroup
										onValueChange={(value: string) =>
											onChange({
												...draft,
												agentId: value === ANY_AGENT ? null : value,
											})
										}
										value={agent?.id ?? ANY_AGENT}
									>
										<DropdownMenuRadioItem value={ANY_AGENT}>
											Any agent
										</DropdownMenuRadioItem>
										{agents.map((option) => (
											<DropdownMenuRadioItem key={option.id} value={option.id}>
												<ForumAvatar agent={option} size={16} />
												{option.name}
											</DropdownMenuRadioItem>
										))}
									</DropdownMenuRadioGroup>
								</DropdownMenuGroup>
							</DropdownMenuContent>
						</DropdownMenu>
					) : null}
				</div>
			</div>
			<label className="sr-only" htmlFor={bodyId}>
				Body
			</label>
			<textarea
				className="max-h-[32vh] min-h-28 w-full resize-none rounded-2xl border border-transparent bg-input/50 px-4 py-3 text-foreground text-sm leading-6 outline-none transition-[color,box-shadow,background-color] [field-sizing:content] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
				id={bodyId}
				onChange={(event) => onChange({ ...draft, body: event.target.value })}
				placeholder="Give the agent the context it needs: what you want, links, constraints."
				value={draft.body}
			/>
			<div className="flex items-center gap-2">
				<Button disabled={!ready} size="sm" type="submit">
					Create topic
				</Button>
				<Button onClick={onDiscard} size="sm" type="button" variant="ghost">
					Cancel
				</Button>
				<span className="flex-1" />
				<span className="@min-[560px]:inline-flex hidden items-center gap-1.5 text-muted-foreground text-xs">
					<Kbd>⌘↵</Kbd>
					to create
				</span>
			</div>
		</form>
	);
}
