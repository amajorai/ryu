import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	NativeSelect,
	NativeSelectOptGroup,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceAgent,
	InterfaceGroup,
	InterfacePort,
} from "@ryuhq/protocol/interfaces";
import {
	type FormEvent,
	type KeyboardEvent,
	type RefObject,
	useId,
	useState,
} from "react";
import { TicketAvatar, TicketStatusPill } from "./tickets-parts.tsx";

const MAX_DESCRIPTION_LENGTH = 8000;
const NO_GROUP = "";

const FIELD_LABEL = "font-medium text-muted-foreground text-xs";

function GroupOptions({ groups }: { groups: InterfaceGroup[] }) {
	const projects = groups.filter((item) => item.kind === "project");
	const teams = groups.filter((item) => item.kind === "team");
	return (
		<>
			<NativeSelectOption value={NO_GROUP}>None</NativeSelectOption>
			{projects.length > 0 ? (
				<NativeSelectOptGroup label="Projects">
					{projects.map((item) => (
						<NativeSelectOption key={item.id} value={item.id}>
							{item.name}
						</NativeSelectOption>
					))}
				</NativeSelectOptGroup>
			) : null}
			{teams.length > 0 ? (
				<NativeSelectOptGroup label="Teams">
					{teams.map((item) => (
						<NativeSelectOption key={item.id} value={item.id}>
							{item.name}
						</NativeSelectOption>
					))}
				</NativeSelectOptGroup>
			) : null}
		</>
	);
}

/**
 * The new-ticket page, shaped like a ticket: the description composer takes
 * the conversation's place and the ticket fields sit where the properties
 * sidebar does (above the composer at narrow widths). Submitting is the
 * explicit user action that lets the host send the description as the first
 * message (`port.startThread`).
 */
export function TicketsNewTicket({
	agents,
	defaultAgentId,
	descriptionRef,
	groups,
	onCancel,
	onSubmit,
	stacked,
}: {
	agents: InterfaceAgent[];
	defaultAgentId: string | undefined;
	descriptionRef: RefObject<HTMLTextAreaElement | null>;
	groups: InterfaceGroup[];
	onCancel: () => void;
	onSubmit: (input: Parameters<InterfacePort["startThread"]>[0]) => void;
	/** Narrow widths put the fields above the composer. */
	stacked: boolean;
}) {
	const tl = useLiteralMessages();
	const requesterFieldId = useId();
	const groupFieldId = useId();
	const descriptionId = useId();
	const hintId = useId();
	const [pickedAgentId, setPickedAgentId] = useState<string>();
	const [groupId, setGroupId] = useState(NO_GROUP);
	const [description, setDescription] = useState("");
	// What the picker shows is always what gets sent, even if agents change.
	const agentId =
		pickedAgentId && agents.some((agent) => agent.id === pickedAgentId)
			? pickedAgentId
			: (defaultAgentId ?? agents[0]?.id);
	const agent = agents.find((item) => item.id === agentId) ?? null;
	const group = groups.find((item) => item.id === groupId);
	const prompt = description.trim();

	const submit = () => {
		if (!prompt) {
			return;
		}
		onSubmit({
			agentId,
			projectId: group?.kind === "project" ? group.id : undefined,
			prompt,
			teamId: group?.kind === "team" ? group.id : undefined,
		});
	};
	const onFormSubmit = (event: FormEvent) => {
		event.preventDefault();
		submit();
	};
	const onDescriptionKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			submit();
		}
		if (event.key === "Escape" && !prompt) {
			event.preventDefault();
			onCancel();
		}
	};

	// In the sidebar the section heading already says "Requester".
	const requesterField = (
		<div className="flex flex-col gap-1.5">
			<label
				className={stacked ? FIELD_LABEL : "sr-only"}
				htmlFor={requesterFieldId}
			>
				Requester
			</label>
			{agents.length > 0 ? (
				<NativeSelect
					className="w-full"
					id={requesterFieldId}
					onChange={(event) => setPickedAgentId(event.target.value)}
					size="sm"
					value={agentId}
				>
					{agents.map((item) => (
						<NativeSelectOption key={item.id} value={item.id}>
							{item.name}
						</NativeSelectOption>
					))}
				</NativeSelect>
			) : (
				<p
					className="flex h-8 items-center text-[13px] text-muted-foreground"
					id={requesterFieldId}
				>
					Your default agent
				</p>
			)}
		</div>
	);
	const groupField = (
		<div className="flex flex-col gap-1.5">
			<label className={FIELD_LABEL} htmlFor={groupFieldId}>
				Project or team
			</label>
			<NativeSelect
				className="w-full"
				disabled={groups.length === 0}
				id={groupFieldId}
				onChange={(event) => setGroupId(event.target.value)}
				size="sm"
				value={groupId}
			>
				<GroupOptions groups={groups} />
			</NativeSelect>
		</div>
	);

	return (
		<section
			aria-labelledby="tickets-new-heading"
			className="flex min-h-0 min-w-0 flex-1 flex-col"
			data-testid="tickets-new-ticket"
		>
			<header className="flex h-12 shrink-0 items-center gap-3 border-border border-b px-5">
				<TicketStatusPill status="new" />
				<h1
					className="font-semibold text-base text-foreground"
					id="tickets-new-heading"
				>
					New ticket
				</h1>
			</header>
			<div className={cn("flex min-h-0 flex-1", stacked && "flex-col")}>
				{stacked ? (
					<div className="grid shrink-0 gap-3 border-border border-b px-5 py-4 sm:grid-cols-2">
						{requesterField}
						{groupField}
					</div>
				) : null}
				<form
					className="flex min-h-0 min-w-0 flex-1 flex-col"
					onSubmit={onFormSubmit}
				>
					<label
						className={cn(FIELD_LABEL, "px-5 pt-4 pb-1")}
						htmlFor={descriptionId}
					>
						Description
					</label>
					<Textarea
						aria-describedby={hintId}
						className="field-sizing-fixed min-h-0 flex-1 rounded-none border-0 bg-transparent px-5 py-1 text-sm leading-6 focus-visible:border-0 focus-visible:ring-0 md:text-sm"
						id={descriptionId}
						maxLength={MAX_DESCRIPTION_LENGTH}
						onChange={(event) => setDescription(event.target.value)}
						onKeyDown={onDescriptionKeyDown}
						placeholder="Describe what you need done"
						ref={descriptionRef}
						value={description}
					/>
					<div className="flex h-14 shrink-0 items-center gap-2 border-border border-t px-5">
						<p
							className="min-w-0 flex-1 truncate text-muted-foreground text-xs"
							id={hintId}
						>
							{agent
								? tl("Sent to {name} as the first message.", {
										name: agent.name,
									})
								: "Sent as the first message."}
						</p>
						<Button onClick={onCancel} size="sm" type="button" variant="ghost">
							Cancel
						</Button>
						<Button
							aria-keyshortcuts="Control+Enter Meta+Enter"
							disabled={!prompt}
							size="sm"
							title="Submit ticket (Ctrl+Enter)"
							type="submit"
						>
							Submit ticket
						</Button>
					</div>
				</form>
				{stacked ? null : (
					<aside
						aria-label="Ticket fields"
						className="flex w-80 shrink-0 flex-col overflow-y-auto border-border border-l"
					>
						<section className="flex flex-col gap-3 border-border border-b p-4">
							<h2 className="font-semibold text-foreground text-xs">
								Requester
							</h2>
							{requesterField}
							{agent ? (
								<div className="flex items-start gap-3">
									<TicketAvatar agent={agent} size={32} />
									<p className="min-w-0 text-[13px] text-muted-foreground leading-5">
										{agent.description ||
											tl("{name} has no description.", { name: agent.name })}
									</p>
								</div>
							) : null}
						</section>
						<section className="flex flex-col gap-3 p-4">
							<h2 className="font-semibold text-foreground text-xs">Ticket</h2>
							<div className="flex flex-col gap-1.5">
								<span className={FIELD_LABEL}>Assignee</span>
								<span className="flex h-8 items-center rounded-lg border border-border bg-muted/30 px-2.5 text-[13px] text-foreground">
									You
								</span>
							</div>
							{groupField}
						</section>
					</aside>
				)}
			</div>
		</section>
	);
}
