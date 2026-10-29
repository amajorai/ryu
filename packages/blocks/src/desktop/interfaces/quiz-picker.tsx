import { useLiteralMessages } from "@ryu/i18n/react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { ChevronDown } from "lucide-react";
import { useId } from "react";

/** Segments in the picker before the rest move into the "Other" menu. */
export const PICKER_SEGMENTS = 4;

const SEGMENT =
	"flex h-8 cursor-pointer items-center gap-1 rounded-sm px-3 font-medium text-sm outline-none transition-colors duration-150 motion-reduce:transition-none";
const SEGMENT_ON = "bg-(--quiz-ink) text-(--quiz-frame)";
const SEGMENT_OFF =
	"text-(--quiz-ink-muted) hover:bg-(--quiz-ink)/10 hover:text-(--quiz-ink)";
const SEGMENT_FOCUS =
	"has-focus-visible:outline-(--quiz-ink) has-focus-visible:outline-2 has-focus-visible:outline-solid has-focus-visible:outline-offset-1";

/**
 * Who answers the final question: the podium contestants as a segmented
 * control, and everyone else behind one "Other" menu so a big roster never
 * wraps into a cloud of names.
 */
export function QuizContestantPicker({
	agents,
	featuredIds,
	onPick,
	pickedId,
}: {
	agents: InterfaceAgent[];
	/** Shown as segments, in this order (the podium line-up). */
	featuredIds: string[];
	onPick: (agentId: string) => void;
	pickedId: string | undefined;
}) {
	const tl = useLiteralMessages();
	const name = useId();
	const byId = new Map(agents.map((agent) => [agent.id, agent]));
	const featured = featuredIds
		.map((id) => byId.get(id))
		.filter((agent): agent is InterfaceAgent => agent !== undefined)
		.slice(0, PICKER_SEGMENTS);
	const segments =
		featured.length > 0 ? featured : agents.slice(0, PICKER_SEGMENTS);
	const segmentIds = new Set(segments.map((agent) => agent.id));
	const others = agents.filter((agent) => !segmentIds.has(agent.id));
	const otherPicked = others.find((agent) => agent.id === pickedId);
	if (agents.length < 2) {
		return null;
	}
	return (
		<fieldset className="flex max-w-full flex-wrap justify-center gap-1">
			<legend className="sr-only">Contestant</legend>
			{segments.map((candidate) => {
				const selected = candidate.id === pickedId;
				return (
					<label
						className={cn(
							SEGMENT,
							SEGMENT_FOCUS,
							selected ? SEGMENT_ON : SEGMENT_OFF
						)}
						key={candidate.id}
					>
						<input
							checked={selected}
							className="sr-only"
							name={name}
							onChange={() => onPick(candidate.id)}
							type="radio"
							value={candidate.id}
						/>
						{candidate.name}
					</label>
				);
			})}
			{others.length > 0 ? (
				<DropdownMenu>
					<DropdownMenuTrigger
						aria-label={
							otherPicked
								? tl("Other contestant: {contestantName}", {
										contestantName: otherPicked.name,
									})
								: "Other contestant"
						}
						className={cn(
							SEGMENT,
							"focus-visible:outline-(--quiz-ink) focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1",
							otherPicked ? SEGMENT_ON : SEGMENT_OFF
						)}
						type="button"
					>
						{otherPicked ? otherPicked.name : "Other"}
						<ChevronDown aria-hidden="true" className="size-3.5" />
					</DropdownMenuTrigger>
					<DropdownMenuContent
						align="end"
						className="max-h-72 w-48"
						drawerLabel="Other contestant"
					>
						<DropdownMenuRadioGroup
							onValueChange={(value: unknown) => {
								if (typeof value === "string") {
									onPick(value);
								}
							}}
							value={otherPicked?.id ?? ""}
						>
							{others.map((agent) => (
								<DropdownMenuRadioItem key={agent.id} value={agent.id}>
									{agent.name}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuContent>
				</DropdownMenu>
			) : null}
		</fieldset>
	);
}
