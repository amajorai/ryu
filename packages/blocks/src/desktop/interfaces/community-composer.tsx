import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { Check, ChevronDown, Search } from "lucide-react";
import { motion } from "motion/react";
import { type FormEvent, type KeyboardEvent, type Ref, useId } from "react";
import {
	type Community,
	type CommunityDraft,
	communityLabel,
	PROFILE_KEY,
	TITLE_LIMIT,
} from "./community-model.ts";
import { CommunityIcon } from "./community-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

const PROFILE_OPTION: Community = {
	agentId: null,
	description: "",
	handle: "you",
	key: PROFILE_KEY,
	kind: "profile",
	lastActivity: null,
	members: [],
	name: "Your profile",
	prefix: "u/",
	seed: "profile:you",
	sourceId: "profile",
	threadCount: 0,
	workingCount: 0,
};

function Option({
	community,
	onPick,
	selected,
}: {
	community: Community;
	onPick: (key: string) => void;
	selected: boolean;
}) {
	return (
		<DropdownMenuItem className="gap-2.5" onClick={() => onPick(community.key)}>
			<CommunityIcon community={community} size={24} />
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-sm">{communityLabel(community)}</span>
				{community.kind === "profile" ? null : (
					<span className="truncate text-muted-foreground text-xs">
						{community.name}
					</span>
				)}
			</span>
			{selected ? (
				<Check
					aria-hidden="true"
					className="size-4 text-primary"
					strokeWidth={2}
				/>
			) : null}
		</DropdownMenuItem>
	);
}

/** Reddit's community picker: a pill that opens the list of places to post. */
function CommunityPicker({
	communities,
	onPick,
	value,
}: {
	communities: readonly Community[];
	onPick: (key: string) => void;
	value: string | null;
}) {
	const tl = useLiteralMessages();
	const groups = communities.filter(
		(community) => community.kind === "project" || community.kind === "team"
	);
	const agents = communities.filter((community) => community.kind === "agent");
	const selected =
		value === PROFILE_KEY
			? PROFILE_OPTION
			: communities.find((community) => community.key === value);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<button
						aria-label={
							selected
								? tl("Community: {community}", {
										community: communityLabel(selected),
									})
								: "Select a community"
						}
						className="flex h-10 items-center gap-2 self-start rounded-full bg-secondary pr-3 pl-1 font-semibold text-secondary-foreground text-sm outline-none transition-colors duration-100 hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_8%)] focus-visible:ring-2 focus-visible:ring-ring/50 data-[popup-open]:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_8%)]"
						data-testid="community-picker"
						type="button"
					/>
				}
			>
				{selected ? (
					<CommunityIcon community={selected} size={32} />
				) : (
					<span
						aria-hidden="true"
						className="flex size-8 items-center justify-center rounded-full bg-background text-muted-foreground"
					>
						<Search className="size-4" strokeWidth={2} />
					</span>
				)}
				{selected ? communityLabel(selected) : "Select a community"}
				<ChevronDown aria-hidden="true" className="size-4" strokeWidth={2} />
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				className="max-h-96 w-72"
				drawerLabel="Choose a community"
			>
				<DropdownMenuGroup>
					<DropdownMenuLabel>Your profile</DropdownMenuLabel>
					<Option
						community={PROFILE_OPTION}
						onPick={onPick}
						selected={value === PROFILE_KEY}
					/>
				</DropdownMenuGroup>
				{groups.length > 0 ? (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuGroup>
							<DropdownMenuLabel>Communities</DropdownMenuLabel>
							{groups.map((community) => (
								<Option
									community={community}
									key={community.key}
									onPick={onPick}
									selected={value === community.key}
								/>
							))}
						</DropdownMenuGroup>
					</>
				) : null}
				{agents.length > 0 ? (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuGroup>
							<DropdownMenuLabel>Agents</DropdownMenuLabel>
							{agents.map((community) => (
								<Option
									community={community}
									key={community.key}
									onPick={onPick}
									selected={value === community.key}
								/>
							))}
						</DropdownMenuGroup>
					</>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export interface ComposerProps {
	canPost: boolean;
	communities: readonly Community[];
	draft: CommunityDraft;
	onCancel: () => void;
	onChange: (draft: CommunityDraft) => void;
	onSubmit: () => void;
	titleRef: Ref<HTMLInputElement>;
}

const FIELD =
	"w-full rounded-2xl border border-border bg-background px-4 text-foreground text-sm outline-none transition-colors duration-100 placeholder:text-muted-foreground hover:border-foreground/30 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30";

/**
 * Reddit's Create post page: pick a community, then a title (required, 300
 * characters) and optional body. Posting is the explicit action that sends
 * the text as the new thread's first message.
 */
export function Composer({
	canPost,
	communities,
	draft,
	onCancel,
	onChange,
	onSubmit,
	titleRef,
}: ComposerProps) {
	const reduceMotion = useReducedMotion();
	const headingId = useId();
	const titleId = useId();
	const bodyId = useId();
	const counterId = useId();
	const onFormSubmit = (event: FormEvent) => {
		event.preventDefault();
		if (canPost) {
			onSubmit();
		}
	};
	const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			onCancel();
		} else if (
			event.key === "Enter" &&
			(event.metaKey || event.ctrlKey) &&
			canPost
		) {
			event.preventDefault();
			onSubmit();
		}
	};
	const length = draft.title.length;
	return (
		<motion.form
			animate={{ opacity: 1 }}
			aria-labelledby={headingId}
			className="flex flex-col gap-4 px-4 pt-6 pb-16"
			data-testid="community-composer"
			initial={reduceMotion ? false : { opacity: 0 }}
			onKeyDown={onKeyDown}
			onSubmit={onFormSubmit}
			transition={{ duration: 0.14, ease: "easeOut" }}
		>
			<h1
				className="font-bold! text-2xl text-foreground leading-8 tracking-tight"
				id={headingId}
			>
				Create post
			</h1>
			<CommunityPicker
				communities={communities}
				onPick={(communityKey) => onChange({ ...draft, communityKey })}
				value={draft.communityKey}
			/>
			<div className="flex flex-col gap-1">
				<label className="sr-only" htmlFor={titleId}>
					Title
				</label>
				<input
					aria-describedby={counterId}
					aria-required="true"
					className={cn(FIELD, "h-14 text-base")}
					id={titleId}
					maxLength={TITLE_LIMIT}
					onChange={(event) =>
						onChange({ ...draft, title: event.target.value })
					}
					placeholder="Title"
					ref={titleRef}
					value={draft.title}
				/>
				<p
					className="self-end pr-2 text-muted-foreground text-xs tabular-nums"
					id={counterId}
				>
					{length}/{TITLE_LIMIT}
				</p>
			</div>
			<div className="flex flex-col">
				<label className="sr-only" htmlFor={bodyId}>
					Body text (optional)
				</label>
				<textarea
					className={cn(FIELD, "min-h-40 resize-y py-3 leading-6")}
					id={bodyId}
					onChange={(event) => onChange({ ...draft, body: event.target.value })}
					placeholder="Body text (optional)"
					value={draft.body}
				/>
			</div>
			<div className="flex items-center justify-end gap-2">
				<Button onClick={onCancel} type="button" variant="secondary">
					Cancel
				</Button>
				<Button disabled={!canPost} type="submit">
					Post
				</Button>
			</div>
		</motion.form>
	);
}
