import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { ChevronDown } from "lucide-react";
import {
	type FormEvent,
	type KeyboardEvent,
	type RefObject,
	useId,
} from "react";
import { PostsAvatar } from "./posts-avatar.tsx";
import {
	findSpace,
	type PostDraft,
	type PostSpace,
	postPrompt,
} from "./posts-model.ts";

const NO_SPACE = "none";
const ANY_AGENT = "any";

function PickerTrigger({ label, value }: { label: string; value: string }) {
	return (
		<DropdownMenuTrigger
			aria-label={`${label}: ${value}`}
			render={
				<button
					className="inline-flex h-7 max-w-48 items-center gap-1 rounded-md px-2 font-medium text-foreground text-sm outline-none transition-colors duration-100 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:bg-muted"
					type="button"
				/>
			}
		>
			<span className="truncate">{value}</span>
			<ChevronDown
				aria-hidden="true"
				className="size-3.5 shrink-0 text-muted-foreground"
				strokeWidth={2}
			/>
		</DropdownMenuTrigger>
	);
}

export interface PostsComposerProps {
	agents: readonly InterfaceAgent[];
	draft: PostDraft;
	onCancel: () => void;
	onChange: (draft: PostDraft) => void;
	onSubmit: () => void;
	spaces: readonly PostSpace[];
	titleRef: RefObject<HTMLInputElement | null>;
}

/**
 * Campsite's composer: where the post goes and who answers it, a large title,
 * then the body. Posting sends title and body as the thread's first message.
 */
export function PostsComposer({
	agents,
	draft,
	onCancel,
	onChange,
	onSubmit,
	spaces,
	titleRef,
}: PostsComposerProps) {
	const titleId = useId();
	const bodyId = useId();
	const postable = spaces.filter((space) => space.kind !== "general");
	const space = findSpace(postable, draft.spaceId);
	const agent = agents.find((candidate) => candidate.id === draft.agentId);
	const ready = postPrompt(draft).length > 0;

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
			onCancel();
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

	return (
		<form
			aria-label="New post"
			className="rounded-xl border border-border bg-card text-card-foreground"
			data-testid="posts-composer"
			onKeyDown={onKeyDown}
			onSubmit={submit}
		>
			<div className="flex flex-wrap items-center gap-x-1 gap-y-1 border-border border-b px-3 py-2 text-muted-foreground text-sm">
				<span className="pl-1">Post in</span>
				<DropdownMenu>
					<PickerTrigger label="Space" value={space?.name ?? "General"} />
					<DropdownMenuContent className="w-56" drawerLabel="Space">
						<DropdownMenuGroup>
							<DropdownMenuLabel>Space</DropdownMenuLabel>
							<DropdownMenuRadioGroup
								onValueChange={(value: string) =>
									onChange({
										...draft,
										spaceId: value === NO_SPACE ? null : value,
									})
								}
								value={space?.id ?? NO_SPACE}
							>
								<DropdownMenuRadioItem value={NO_SPACE}>
									General
								</DropdownMenuRadioItem>
								{postable.map((option) => (
									<DropdownMenuRadioItem key={option.id} value={option.id}>
										{option.name}
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuGroup>
					</DropdownMenuContent>
				</DropdownMenu>
				{agents.length > 0 ? (
					<>
						<span className="pl-1">for</span>
						<DropdownMenu>
							<PickerTrigger label="Agent" value={agent?.name ?? "Any agent"} />
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
												<PostsAvatar agent={option} size={16} />
												{option.name}
											</DropdownMenuRadioItem>
										))}
									</DropdownMenuRadioGroup>
								</DropdownMenuGroup>
							</DropdownMenuContent>
						</DropdownMenu>
					</>
				) : null}
			</div>
			<div className="flex flex-col gap-1 px-4 pt-3 pb-2">
				<label className="sr-only" htmlFor={titleId}>
					Title
				</label>
				<input
					autoComplete="off"
					className="h-8 w-full bg-transparent font-semibold text-foreground text-lg leading-8 outline-none placeholder:text-muted-foreground/70"
					id={titleId}
					onChange={(event) =>
						onChange({ ...draft, title: event.target.value })
					}
					placeholder="Title"
					ref={titleRef}
					value={draft.title}
				/>
				<label className="sr-only" htmlFor={bodyId}>
					Body
				</label>
				<textarea
					className="field-sizing-content max-h-60 min-h-16 w-full resize-none bg-transparent text-foreground text-sm leading-6 outline-none placeholder:text-muted-foreground/70"
					id={bodyId}
					onChange={(event) => onChange({ ...draft, body: event.target.value })}
					placeholder="Share context, a question, or what you need back"
					rows={3}
					value={draft.body}
				/>
			</div>
			<div className="flex items-center gap-2 px-3 pb-3">
				<span className="hidden items-center gap-1.5 pl-1 text-muted-foreground text-xs sm:inline-flex">
					<Kbd>⌘↵</Kbd>
					to post
				</span>
				<span className="flex-1" />
				<Button onClick={onCancel} size="sm" type="button" variant="ghost">
					Cancel
				</Button>
				<Button disabled={!ready} size="sm" type="submit">
					Post
				</Button>
			</div>
		</form>
	);
}
