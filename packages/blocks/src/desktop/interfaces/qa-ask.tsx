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
import { Input } from "@ryu/ui/components/input.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import type {
	InterfaceAgent,
	InterfaceGroup,
} from "@ryuhq/protocol/interfaces";
import { ChevronDown } from "lucide-react";
import { motion } from "motion/react";
import {
	type FormEvent,
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useId,
} from "react";
import { QaAvatar } from "./qa-avatar.tsx";
import { type QaDraft, qaPrompt } from "./qa-model.ts";
import { useReducedMotion } from "./reduced-motion.ts";

const ANY_AGENT = "any";
const NO_TOPIC = "none";

function Field({
	children,
	hint,
	htmlFor,
	label,
	labelId,
	optional = false,
}: {
	children: ReactNode;
	hint: string;
	htmlFor?: string;
	label: string;
	labelId?: string;
	optional?: boolean;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<div className="flex flex-col">
				<label
					className="font-medium text-foreground text-sm leading-6"
					htmlFor={htmlFor}
					id={labelId}
				>
					{label}
					{optional ? (
						<span className="pl-1.5 font-normal text-muted-foreground">
							Optional
						</span>
					) : null}
				</label>
				<p className="text-muted-foreground text-xs leading-5">{hint}</p>
			</div>
			{children}
		</div>
	);
}

function PickerTrigger({
	labelledBy,
	leading,
	value,
}: {
	labelledBy: string;
	leading?: ReactNode;
	value: string;
}) {
	return (
		<DropdownMenuTrigger
			aria-labelledby={labelledBy}
			render={
				<button
					className="flex h-9 w-full min-w-0 items-center gap-2 rounded-3xl border border-transparent bg-input/50 px-3 text-left text-foreground text-sm outline-none transition-[color,box-shadow,background-color] hover:bg-input/70 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
					type="button"
				/>
			}
		>
			{leading}
			<span className="min-w-0 flex-1 truncate">{value}</span>
			<ChevronDown
				aria-hidden="true"
				className="size-4 shrink-0 text-muted-foreground"
				strokeWidth={2}
			/>
		</DropdownMenuTrigger>
	);
}

export interface QaAskProps {
	agents: readonly InterfaceAgent[];
	draft: QaDraft;
	groups: readonly InterfaceGroup[];
	onCancel: () => void;
	onChange: (draft: QaDraft) => void;
	onSubmit: () => void;
	titleRef: RefObject<HTMLInputElement | null>;
}

/**
 * Stack Overflow's Ask page, trimmed to what a thread needs: the question,
 * optional details, who should answer, and a topic to file it under. Posting
 * sends the question and details as the thread's first message.
 */
export function QaAsk({
	agents,
	draft,
	groups,
	onCancel,
	onChange,
	onSubmit,
	titleRef,
}: QaAskProps) {
	const reduceMotion = useReducedMotion();
	const titleId = useId();
	const bodyId = useId();
	const agentLabelId = useId();
	const topicLabelId = useId();
	const agent = agents.find((candidate) => candidate.id === draft.agentId);
	const topic = groups.find((group) => group.id === draft.topicId);
	const ready = qaPrompt(draft).length > 0;

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
		<motion.form
			animate={{ opacity: 1, y: 0 }}
			aria-labelledby={`${titleId}-heading`}
			className="flex flex-col gap-6 pt-6 pb-16"
			data-testid="qa-ask"
			initial={reduceMotion ? false : { opacity: 0, y: 4 }}
			onKeyDown={onKeyDown}
			onSubmit={submit}
			transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}
		>
			<div className="flex flex-col gap-1">
				<h1
					className="font-semibold! text-2xl text-foreground leading-8 tracking-tight"
					id={`${titleId}-heading`}
				>
					Ask a question
				</h1>
				<p className="max-w-[60ch] text-muted-foreground text-sm leading-6">
					Your question starts a thread. Agent replies show up as its answers.
				</p>
			</div>
			<Field
				hint="One specific question. It becomes the thread's title."
				htmlFor={titleId}
				label="Question"
			>
				<Input
					autoComplete="off"
					id={titleId}
					onChange={(event) =>
						onChange({ ...draft, title: event.target.value })
					}
					placeholder="e.g. Why does the gateway take 4 seconds to cold start?"
					ref={titleRef}
					value={draft.title}
				/>
			</Field>
			<Field
				hint="What you tried, the constraints, and what a good answer looks like."
				htmlFor={bodyId}
				label="Details"
				optional
			>
				<Textarea
					className="max-h-72 min-h-32"
					id={bodyId}
					onChange={(event) => onChange({ ...draft, body: event.target.value })}
					rows={5}
					value={draft.body}
				/>
			</Field>
			<div className="grid @[640px]/qa:grid-cols-2 gap-6">
				<Field
					hint="Leave it on any agent to let Ryu choose."
					label="Who answers"
					labelId={agentLabelId}
					optional
				>
					<DropdownMenu>
						<PickerTrigger
							labelledBy={agentLabelId}
							leading={agent ? <QaAvatar agent={agent} size={20} /> : null}
							value={agent?.name ?? "Any agent"}
						/>
						<DropdownMenuContent className="w-60" drawerLabel="Who answers">
							<DropdownMenuGroup>
								<DropdownMenuLabel>Who answers</DropdownMenuLabel>
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
											<QaAvatar agent={option} size={16} />
											{option.name}
										</DropdownMenuRadioItem>
									))}
								</DropdownMenuRadioGroup>
							</DropdownMenuGroup>
						</DropdownMenuContent>
					</DropdownMenu>
				</Field>
				<Field
					hint="File it under a project or team."
					label="Topic"
					labelId={topicLabelId}
					optional
				>
					<DropdownMenu>
						<PickerTrigger
							labelledBy={topicLabelId}
							value={topic?.name ?? "No topic"}
						/>
						<DropdownMenuContent className="w-60" drawerLabel="Topic">
							<DropdownMenuGroup>
								<DropdownMenuLabel>Topic</DropdownMenuLabel>
								<DropdownMenuRadioGroup
									onValueChange={(value: string) =>
										onChange({
											...draft,
											topicId: value === NO_TOPIC ? null : value,
										})
									}
									value={topic?.id ?? NO_TOPIC}
								>
									<DropdownMenuRadioItem value={NO_TOPIC}>
										No topic
									</DropdownMenuRadioItem>
									{groups.map((option) => (
										<DropdownMenuRadioItem key={option.id} value={option.id}>
											<span className="min-w-0 flex-1 truncate">
												{option.name}
											</span>
											<span className="text-muted-foreground text-xs capitalize">
												{option.kind}
											</span>
										</DropdownMenuRadioItem>
									))}
								</DropdownMenuRadioGroup>
							</DropdownMenuGroup>
						</DropdownMenuContent>
					</DropdownMenu>
				</Field>
			</div>
			<div className="flex flex-wrap items-center gap-2 border-border border-t pt-6">
				<Button disabled={!ready} size="sm" type="submit">
					Post your question
				</Button>
				<Button onClick={onCancel} size="sm" type="button" variant="ghost">
					Discard
				</Button>
				<span className="ml-auto @[640px]/qa:inline-flex hidden items-center gap-1.5 text-muted-foreground text-xs">
					<Kbd>⌘↵</Kbd>
					to post
				</span>
			</div>
		</motion.form>
	);
}
