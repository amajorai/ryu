import {
	Add01Icon,
	Cancel01Icon,
	Delete02Icon,
	PlayIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	emptyEnvironmentScripts,
	type ProjectEnvironment,
} from "@/src/store/useWorkspaceStore.ts";
import { newId } from "./ProjectSettingsDialog-environment-model.ts";
import { ScriptEditor } from "./ProjectSettingsDialog-script-editor.tsx";

export function EnvironmentEditor({
	environment,
	isActive,
	onChange,
	onDelete,
	onMakeActive,
}: {
	environment: ProjectEnvironment;
	isActive: boolean;
	onChange: (environment: ProjectEnvironment) => void;
	onDelete: () => void;
	onMakeActive: () => void;
}) {
	const tl = useLiteralMessages();
	return (
		<div className="flex flex-col gap-4 rounded-lg border bg-muted/15 p-4">
			<div className="flex items-end gap-2">
				<div className="min-w-0 flex-1 space-y-1.5">
					<Label htmlFor={`environment-${environment.id}-name`}>Name</Label>
					<Input
						id={`environment-${environment.id}-name`}
						onChange={(event) =>
							onChange({ ...environment, name: event.target.value })
						}
						placeholder="Local"
						value={environment.name}
					/>
				</div>
				<Button
					disabled={isActive}
					onClick={onMakeActive}
					type="button"
					variant="ghost"
				>
					{isActive ? "Active" : "Make active"}
				</Button>
				<Button
					aria-label={tl("Delete {name}", { name: environment.name })}
					onClick={onDelete}
					size="icon"
					type="button"
					variant="ghost"
				>
					<HugeiconsIcon className="size-4" icon={Delete02Icon} />
				</Button>
			</div>

			<div className="rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-muted-foreground text-xs">
				Setup and cleanup shell hooks are unavailable for chat worktrees. Use a
				local action or a reviewed project instruction instead; environment
				variables remain available to the coding agent.
			</div>

			<div className="space-y-2">
				<div className="flex items-center justify-between">
					<div>
						<Label>Variables</Label>
						<p className="text-muted-foreground text-xs">
							Inherited by actions and the coding agent. Do not store secrets
							here.
						</p>
					</div>
					<Button
						onClick={() =>
							onChange({
								...environment,
								variables: [
									...environment.variables,
									{ id: newId(), key: "", value: "" },
								],
							})
						}
						size="sm"
						type="button"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={Add01Icon} />
						Add variable
					</Button>
				</div>
				{environment.variables.map((variable) => (
					<div className="flex gap-2" key={variable.id}>
						<Input
							aria-label="Variable name"
							onChange={(event) =>
								onChange({
									...environment,
									variables: environment.variables.map((item) =>
										item.id === variable.id
											? { ...item, key: event.target.value }
											: item
									),
								})
							}
							placeholder="DATABASE_URL"
							value={variable.key}
							variant="code"
						/>
						<Input
							aria-label="Variable value"
							onChange={(event) =>
								onChange({
									...environment,
									variables: environment.variables.map((item) =>
										item.id === variable.id
											? { ...item, value: event.target.value }
											: item
									),
								})
							}
							placeholder="value"
							value={variable.value}
							variant="code"
						/>
						<Button
							aria-label={
								variable.key
									? tl("Remove {name}", { name: variable.key })
									: tl("Remove variable")
							}
							onClick={() =>
								onChange({
									...environment,
									variables: environment.variables.filter(
										(item) => item.id !== variable.id
									),
								})
							}
							size="icon"
							type="button"
							variant="ghost"
						>
							<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
						</Button>
					</div>
				))}
			</div>

			<div className="space-y-2 border-t pt-4">
				<div className="flex items-center justify-between">
					<div>
						<Label>Actions</Label>
						<p className="text-muted-foreground text-xs">
							Commands shown beside the active environment in the workspace bar.
						</p>
					</div>
					<Button
						onClick={() =>
							onChange({
								...environment,
								actions: [
									...environment.actions,
									{
										id: newId(),
										name: "Run",
										scripts: emptyEnvironmentScripts(),
									},
								],
							})
						}
						size="sm"
						type="button"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={Add01Icon} />
						Add action
					</Button>
				</div>
				{environment.actions.map((action) => (
					<div className="rounded-md border bg-background p-3" key={action.id}>
						<div className="mb-3 flex gap-2">
							<HugeiconsIcon
								className="mt-2.5 size-4 text-muted-foreground"
								icon={PlayIcon}
							/>
							<Input
								aria-label="Action name"
								onChange={(event) =>
									onChange({
										...environment,
										actions: environment.actions.map((item) =>
											item.id === action.id
												? { ...item, name: event.target.value }
												: item
										),
									})
								}
								placeholder="Dev stack"
								value={action.name}
							/>
							<Button
								aria-label={tl("Remove {name}", { name: action.name })}
								onClick={() =>
									onChange({
										...environment,
										actions: environment.actions.filter(
											(item) => item.id !== action.id
										),
									})
								}
								size="icon"
								type="button"
								variant="ghost"
							>
								<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
							</Button>
						</div>
						<ScriptEditor
							compact
							label="Command"
							onChange={(scripts) =>
								onChange({
									...environment,
									actions: environment.actions.map((item) =>
										item.id === action.id ? { ...item, scripts } : item
									),
								})
							}
							placeholder="bun run dev"
							scripts={action.scripts}
						/>
					</div>
				))}
			</div>
		</div>
	);
}
