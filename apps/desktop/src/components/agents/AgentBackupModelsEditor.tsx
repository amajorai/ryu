// apps/desktop/src/components/agents/AgentBackupModelsEditor.tsx
//
// The ordered backup models of an agent. When no account can serve the model
// a request names, Core runs these in order, each a model on a provider. The
// list belongs to the agent, not to a pool. Each change is saved at once
// together with the agent's current mode, because Core reads a body without a
// mode as "no pool".

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { type SubmitEvent, useId, useState } from "react";
import { type BackupModel, moveBackup } from "@/src/lib/api/account-pools.ts";

export interface BackupProvider {
	id: string;
	label: string;
	models: string[];
}

export function AgentBackupModelsEditor({
	backups,
	busy,
	disabled,
	max,
	onChange,
	providers,
}: {
	backups: BackupModel[];
	busy: boolean;
	disabled: boolean;
	max: number;
	onChange: (next: BackupModel[]) => void;
	providers: BackupProvider[];
}) {
	const tl = useLiteralMessages();
	const formId = useId();
	const [picked, setProviderId] = useState("");
	const [model, setModel] = useState("");
	// Until the user picks one, the first provider is the choice.
	const providerId = picked || providers[0]?.id || "";
	const locked = disabled || busy;
	const labelOf = (id: string) =>
		providers.find((provider) => provider.id === id)?.label ?? id;
	const chosen = providers.find((provider) => provider.id === providerId);
	const trimmed = model.trim();
	const duplicate = backups.some(
		(entry) => entry.providerId === providerId && entry.model === trimmed
	);
	const full = backups.length >= max;
	const canAdd =
		!(locked || full || duplicate) && providerId !== "" && trimmed !== "";

	const add = (event: SubmitEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!canAdd) {
			return;
		}
		onChange([...backups, { model: trimmed, providerId }]);
		setModel("");
	};

	return (
		<div className="flex flex-col gap-3">
			<div className="space-y-1">
				<p className="font-medium text-sm">Backup models</p>
				<p className="text-detail text-muted-foreground">
					When no account can serve the agent's model, these run in this order.
				</p>
			</div>
			{backups.length === 0 ? (
				<p className="text-muted-foreground text-sm">No backup models yet.</p>
			) : (
				<ol className="flex flex-col gap-2">
					{backups.map((entry, index) => (
						<li
							className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
							key={`${entry.providerId}\u0000${entry.model}`}
						>
							<span className="min-w-0 break-words text-sm">
								{`${index + 1}. ${entry.model}`}
								<span className="text-muted-foreground">
									{` · ${labelOf(entry.providerId)}`}
								</span>
							</span>
							<div className="flex gap-1">
								<Button
									aria-label={tl("Move {model} up", { model: entry.model })}
									disabled={locked || index === 0}
									onClick={() => onChange(moveBackup(backups, index, -1))}
									size="sm"
									type="button"
									variant="outline"
								>
									Move up
								</Button>
								<Button
									aria-label={tl("Move {model} down", { model: entry.model })}
									disabled={locked || index === backups.length - 1}
									onClick={() => onChange(moveBackup(backups, index, 1))}
									size="sm"
									type="button"
									variant="outline"
								>
									Move down
								</Button>
								<Button
									aria-label={tl("Remove {model}", { model: entry.model })}
									disabled={locked}
									onClick={() =>
										onChange(backups.filter((_, at) => at !== index))
									}
									size="sm"
									type="button"
									variant="outline"
								>
									Remove
								</Button>
							</div>
						</li>
					))}
				</ol>
			)}
			{full ? (
				<p className="text-detail text-muted-foreground">
					{tl(
						"An agent has at most {count, plural, one {# backup model} other {# backup models}}.",
						{ count: max }
					)}
				</p>
			) : (
				<form
					className="flex flex-col gap-2 sm:flex-row sm:items-end"
					onSubmit={add}
				>
					<div className="space-y-1.5 sm:w-48">
						<Label htmlFor={`${formId}-provider`}>Provider</Label>
						<Select
							disabled={locked}
							onValueChange={setProviderId}
							value={providerId}
						>
							<SelectTrigger id={`${formId}-provider`}>
								<SelectValue placeholder={tl("Choose a provider")}>
									{chosen ? chosen.label : tl("Choose a provider")}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{providers.map((provider) => (
									<SelectItem key={provider.id} value={provider.id}>
										{provider.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="min-w-0 flex-1 space-y-1.5">
						<Label htmlFor={`${formId}-model`}>Model</Label>
						<Input
							disabled={locked}
							id={`${formId}-model`}
							list={`${formId}-models`}
							maxLength={200}
							onChange={(event) => setModel(event.target.value)}
							value={model}
						/>
						<datalist id={`${formId}-models`}>
							{(chosen?.models ?? []).map((name) => (
								<option key={name} value={name} />
							))}
						</datalist>
					</div>
					<Button disabled={!canAdd} size="sm" type="submit">
						Add
					</Button>
				</form>
			)}
			{duplicate && trimmed !== "" ? (
				<p className="text-detail text-muted-foreground">
					This model is in the list already.
				</p>
			) : null}
		</div>
	);
}
