// Prompt Studio: compared models, judge model, and run hints.

import { Add01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { useCallback } from "react";

interface ModelControlsProps {
	extraModels: string[];
	judgeModel: string;
	locked: boolean;
	newModel: string;
	onAddModel: () => void;
	onJudgeChange: (v: string) => void;
	onNewModelChange: (v: string) => void;
	onRemoveModel: (m: string) => void;
	primaryModel: string;
}

export function ModelControls({
	primaryModel,
	extraModels,
	newModel,
	judgeModel,
	locked,
	onNewModelChange,
	onAddModel,
	onRemoveModel,
	onJudgeChange,
}: ModelControlsProps) {
	const tl = useLiteralMessages();
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			if (e.key === "Enter") {
				e.preventDefault();
				onAddModel();
			}
		},
		[onAddModel]
	);

	return (
		<div className="flex flex-col gap-2 rounded-lg bg-muted/20 p-3">
			<div className="flex flex-wrap items-center gap-1.5">
				<span className="font-medium text-xs">Models</span>
				<Badge variant="secondary">{primaryModel || "no model"}</Badge>
				{extraModels.map((m) => (
					<Badge key={m} trailingAction variant="outline">
						{m}
						<Button
							aria-label={tl("Remove model {model}", { model: m })}
							className="size-4"
							disabled={locked}
							onClick={() => onRemoveModel(m)}
							size="icon-sm"
							variant="ghost"
						>
							<HugeiconsIcon className="size-2.5" icon={Cancel01Icon} />
						</Button>
					</Badge>
				))}
			</div>
			<div className="flex flex-wrap items-end gap-2">
				<div className="flex flex-col gap-1">
					<Label htmlFor="ps-add-model" size="caption">
						Add model to compare
					</Label>
					<div className="flex items-center gap-1">
						<Input
							className="w-48"
							disabled={locked}
							id="ps-add-model"
							onChange={(e) => onNewModelChange(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder="e.g. claude-3-5-haiku"
							size="dense"
							value={newModel}
						/>
						<Button
							aria-label="Add model"
							disabled={locked}
							onClick={onAddModel}
							size="icon-sm"
							variant="ghost"
						>
							<HugeiconsIcon className="size-3" icon={Add01Icon} />
						</Button>
					</div>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor="ps-judge-model" size="caption">
						Judge model (optional)
					</Label>
					<Input
						className="w-48"
						disabled={locked}
						id="ps-judge-model"
						onChange={(e) => onJudgeChange(e.target.value)}
						placeholder="defaults to the first model"
						size="dense"
						value={judgeModel}
					/>
				</div>
			</div>
		</div>
	);
}

export function RunHint({
	isAcp,
	missingModel,
	largeMatrix,
}: {
	isAcp: boolean;
	missingModel: boolean;
	largeMatrix: boolean;
}) {
	if (missingModel) {
		return (
			<span className="text-muted-foreground text-xs">
				No model bound — wire the agent's model to run evals.
			</span>
		);
	}
	if (isAcp) {
		return (
			<span className="text-muted-foreground text-xs">
				ACP agents bypass the gateway, so gateway evals do not apply.
			</span>
		);
	}
	if (largeMatrix) {
		return (
			<span className="text-status-warning text-xs dark:text-status-warning">
				Large matrix — this may be slow and could hit a 120s timeout.
			</span>
		);
	}
	return null;
}
