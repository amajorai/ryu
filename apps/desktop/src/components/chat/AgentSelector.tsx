import { Add01Icon, BotIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectSeparator,
	SelectTrigger,
} from "@ryu/ui/components/select";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAgents } from "@/src/hooks/useAgents.ts";

const CREATE_AGENT_VALUE = "__create_agent__";

interface AgentSelectorProps {
	onChange: (agentId: string) => void;
	value: string | null;
}

export function AgentSelector({ value, onChange }: AgentSelectorProps) {
	const navigate = useNavigate();
	const { agents } = useAgents();

	const selectedLabel = useMemo(() => {
		if (!value) {
			return null;
		}
		const agent = agents.find((a) => a.id === value);
		if (agent) {
			return agent.name;
		}
		return null;
	}, [value, agents]);

	const handleChange = (next: string) => {
		if (next === CREATE_AGENT_VALUE) {
			navigate("/agents/new/edit");
			return;
		}
		onChange(next);
	};

	return (
		<Select
			onValueChange={(next) => next && handleChange(next)}
			value={value ?? undefined}
		>
			<SelectTrigger className="h-8 w-56 overflow-hidden" size="sm">
				<span className="flex min-w-0 flex-1 items-center gap-2">
					<HugeiconsIcon
						className="size-4 shrink-0 opacity-70"
						icon={BotIcon}
					/>
					<span className="truncate">
						{selectedLabel ?? (
							<span className="text-muted-foreground">
								{value ? "…" : "Select an agent"}
							</span>
						)}
					</span>
				</span>
			</SelectTrigger>
			<SelectContent
				searchable={agents.length >= 7}
				searchPlaceholder="Search agents…"
			>
				{agents.length > 0 ? (
					<SelectGroup>
						<SelectLabel>Your agents</SelectLabel>
						{agents.map((agent) => (
							<SelectItem key={agent.id} value={agent.id}>
								{agent.name}
							</SelectItem>
						))}
					</SelectGroup>
				) : null}
				<SelectSeparator />
				<SelectItem value={CREATE_AGENT_VALUE}>
					<span className="flex items-center gap-2">
						<HugeiconsIcon className="size-4" icon={Add01Icon} />
						New agent
					</span>
				</SelectItem>
			</SelectContent>
		</Select>
	);
}
