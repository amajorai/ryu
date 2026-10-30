import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { Dispatch, SetStateAction } from "react";
import type { ProjectEnvironment } from "@/src/store/useWorkspaceStore.ts";
import { EnvironmentEditor } from "./ProjectSettingsDialog-environment-editor.tsx";
import { newEnvironment } from "./ProjectSettingsDialog-environment-model.ts";

export function ProjectEnvironmentsSection({
	activeEnvironmentId,
	editingEnvironmentId,
	environments,
	setActiveEnvironmentId,
	setEditingEnvironmentId,
	setEnvironments,
}: {
	activeEnvironmentId: string | null;
	editingEnvironmentId: string | null;
	environments: ProjectEnvironment[];
	setActiveEnvironmentId: Dispatch<SetStateAction<string | null>>;
	setEditingEnvironmentId: Dispatch<SetStateAction<string | null>>;
	setEnvironments: Dispatch<SetStateAction<ProjectEnvironment[]>>;
}) {
	return (
		<section className="flex flex-col gap-3 border-t pt-4">
			<div className="flex items-start justify-between gap-4">
				<div>
					<h3 className="font-medium text-sm">Local environments</h3>
					<p className="text-muted-foreground text-xs">
						Named setups for worktrees, agent processes, and project actions.
					</p>
				</div>
				<Button
					onClick={() => {
						const environment = newEnvironment(
							`Local ${environments.length + 1}`
						);
						setEnvironments((current) => [...current, environment]);
						setEditingEnvironmentId(environment.id);
						setActiveEnvironmentId((current) => current ?? environment.id);
					}}
					size="sm"
					type="button"
					variant="ghost"
				>
					<HugeiconsIcon className="size-4" icon={Add01Icon} />
					Add environment
				</Button>
			</div>

			{environments.length === 0 ? (
				<button
					className="rounded-lg border border-dashed px-4 py-8 text-muted-foreground text-sm transition-colors hover:bg-muted/40"
					onClick={() => {
						const environment = newEnvironment();
						setEnvironments([environment]);
						setEditingEnvironmentId(environment.id);
						setActiveEnvironmentId(environment.id);
					}}
					type="button"
				>
					Add a local environment setup
				</button>
			) : (
				<>
					<div className="flex flex-wrap gap-1">
						{environments.map((environment) => (
							<button
								className={cn(
									"rounded-md px-3 py-1.5 text-xs transition-colors",
									editingEnvironmentId === environment.id
										? "bg-foreground text-background"
										: "bg-muted text-muted-foreground hover:text-foreground"
								)}
								key={environment.id}
								onClick={() => setEditingEnvironmentId(environment.id)}
								type="button"
							>
								{environment.name}
								{activeEnvironmentId === environment.id ? " · Active" : ""}
							</button>
						))}
					</div>
					{environments.map((environment) =>
						environment.id === editingEnvironmentId ? (
							<EnvironmentEditor
								environment={environment}
								isActive={activeEnvironmentId === environment.id}
								key={environment.id}
								onChange={(next) =>
									setEnvironments((current) =>
										current.map((item) => (item.id === next.id ? next : item))
									)
								}
								onDelete={() => {
									const remaining = environments.filter(
										(item) => item.id !== environment.id
									);
									setEnvironments(remaining);
									setEditingEnvironmentId(remaining[0]?.id ?? null);
									if (activeEnvironmentId === environment.id) {
										setActiveEnvironmentId(remaining[0]?.id ?? null);
									}
								}}
								onMakeActive={() => setActiveEnvironmentId(environment.id)}
							/>
						) : null
					)}
				</>
			)}
		</section>
	);
}
