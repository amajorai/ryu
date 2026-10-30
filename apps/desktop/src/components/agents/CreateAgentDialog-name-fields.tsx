import { MagicWand01Icon, Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { useId } from "react";

const NAME_MAX_LENGTH = 64;
const TITLE_MAX_LENGTH = 48;

interface CreateAgentTitleFieldProps {
	onTitleChange: (next: string) => void;
	submitting: boolean;
	title: string;
}

// The "Title badge" field of `CreateAgentDialog`.
export function CreateAgentTitleField({
	onTitleChange,
	submitting,
	title,
}: CreateAgentTitleFieldProps) {
	const titleId = useId();
	return (
		<div className="flex flex-col gap-2">
			<Label htmlFor={titleId}>Title badge</Label>
			<Input
				autoComplete="off"
				disabled={submitting}
				id={titleId}
				maxLength={TITLE_MAX_LENGTH}
				onChange={(event) => onTitleChange(event.target.value)}
				placeholder="e.g. CTO or Release engineer"
				value={title}
			/>
			<p className="text-detail text-muted-foreground">
				Shown beside the agent name in chat and the sidebar.
			</p>
		</div>
	);
}

interface CreateAgentNameFieldProps {
	generatingName: boolean;
	instructions: string;
	name: string;
	onGenerateName: () => void;
	onNameChange: (next: string) => void;
	onReroll: () => void;
	submitting: boolean;
}

// The "Name" field of `CreateAgentDialog`, with reroll and generate buttons.
export function CreateAgentNameField({
	generatingName,
	instructions,
	name,
	onGenerateName,
	onNameChange,
	onReroll,
	submitting,
}: CreateAgentNameFieldProps) {
	const nameId = useId();
	return (
		<div className="flex flex-col gap-2">
			<Label htmlFor={nameId}>Name</Label>
			<div className="flex items-center gap-1">
				<Input
					autoComplete="off"
					className="min-w-0 flex-1"
					disabled={submitting || generatingName}
					id={nameId}
					maxLength={NAME_MAX_LENGTH}
					onChange={(event) => onNameChange(event.target.value)}
					placeholder="Release engineer"
					value={name}
				/>
				<Button
					aria-label="Pick another name"
					disabled={submitting || generatingName}
					onClick={onReroll}
					size="icon-sm"
					title="Pick another name"
					variant="ghost-muted"
				>
					<HugeiconsIcon className="size-4" icon={Refresh01Icon} />
				</Button>
				<Button
					aria-label="Generate a name from the agent instructions"
					disabled={submitting || generatingName || !instructions.trim()}
					onClick={onGenerateName}
					size="icon-sm"
					title="Use this after you set what the agent should do"
					variant="ghost-muted"
				>
					<HugeiconsIcon
						className={generatingName ? "size-4 animate-spin" : "size-4"}
						icon={MagicWand01Icon}
					/>
				</Button>
			</div>
			<p className="text-detail text-muted-foreground">
				Reroll it, or use the wand after writing the instructions.
			</p>
		</div>
	);
}
