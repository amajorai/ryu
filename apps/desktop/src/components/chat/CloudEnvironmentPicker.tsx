import { CLOUD_TASKS_BOX_BACKEND_FLAG } from "@ryu/auth/lib/feature-flags";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import { lazy, Suspense, useEffect, useState } from "react";
import { WORKSPACE_SELECT_TRIGGER } from "@/components/agent-elements/input/composer-select.ts";
import { useFeatureFlag } from "@/src/hooks/useFeatureFlag.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type CloudEnvironment,
	fetchCloudEnvironments,
} from "@/src/lib/api/cloud-environments.ts";
import {
	CLOUD_EXECUTOR_LABELS,
	type CloudTaskSelection,
	managedCloudExecutor,
	useCloudTaskSelections,
} from "@/src/lib/cloud-task-selection.ts";
import { CloudGithubConnectionDialog } from "./CloudGithubConnectionDialog.tsx";
import { InlineErrorRow } from "./InlineErrorRow.tsx";

// The environment editor only renders inside the Manage dialog.
const CloudEnvironmentsSettings = lazy(() =>
	import("@/src/components/gateway/CloudEnvironmentsSettings.tsx").then(
		(module) => ({ default: module.CloudEnvironmentsSettings })
	)
);

export function CloudEnvironmentPicker({
	target,
	scope,
	selection,
	onRetry,
}: {
	target: ApiTarget;
	scope: string | null;
	selection: CloudTaskSelection;
	onRetry?: () => void;
}) {
	// Fresh cloud box rollout gate (UI-only; the node's Box configuration is the hard gate).
	const boxBackendEnabled = useFeatureFlag(CLOUD_TASKS_BOX_BACKEND_FLAG);
	const tl = useLiteralMessages();
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [profiles, setProfiles] = useState<
		Pick<CloudEnvironment, "id" | "name" | "repositories" | "runtime">[]
	>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [manage, setManage] = useState<"create" | "manage" | null>(null);
	const [reload, setReload] = useState(0);
	const [githubOpen, setGithubOpen] = useState(false);
	const [repositoryDraft, setRepositoryDraft] = useState<{
		repository: string;
		vaultKey: string;
	} | null>(null);
	useEffect(() => {
		const controller = new AbortController();
		setProfiles([]);
		setError(null);
		setLoading(true);
		fetchCloudEnvironments(target, controller.signal)
			.then((snapshot) => {
				if (!controller.signal.aborted) {
					setProfiles(
						snapshot.environments
							.filter((environment) => environment.published)
							.map(({ id, name, repositories, runtime }) => ({
								id,
								name,
								repositories,
								runtime,
							}))
					);
				}
			})
			.catch((failure) => {
				if (!controller.signal.aborted) {
					setError(
						failure instanceof Error
							? failure.message
							: "Could not load cloud environments"
					);
				}
			})
			.finally(() => {
				if (!controller.signal.aborted) {
					setLoading(false);
				}
			});
		return () => controller.abort();
	}, [target.url, target.token, target.userJwt, reload]);
	const locked = "locked" in selection && selection.locked;
	const cloud = selection.mode === "cloud";
	const selected = cloud
		? profiles.find((profile) => profile.id === selection.environmentId)
		: undefined;
	const managedExecutor = managedCloudExecutor(selection, {
		boxBackendEnabled,
	});
	const change = (next: CloudTaskSelection) => {
		if (scope) {
			useCloudTaskSelections.getState().setSelection(scope, next);
		}
	};
	return (
		<>
			<div className="flex flex-wrap items-center gap-1">
				<Button
					aria-pressed={cloud}
					// The same chip as the computer and project triggers beside it.
					className={`${WORKSPACE_SELECT_TRIGGER} font-normal text-muted-foreground`}
					disabled={
						!scope ||
						locked ||
						selection.mode === "loading" ||
						selection.mode === "error"
					}
					onClick={() =>
						change(
							cloud
								? { mode: "local", locked: false }
								: {
										mode: "cloud",
										environmentId: null,
										runtime: null,
										locked: false,
									}
						)
					}
					size="sm"
					variant="ghost"
				>
					{cloud
						? managedExecutor
							? tl("Cloud · {executorLabel}", {
									executorLabel: CLOUD_EXECUTOR_LABELS[managedExecutor],
								})
							: "Cloud"
						: "Use cloud"}
				</Button>
				{cloud ? (
					<Popover onOpenChange={setOpen} open={open}>
						<PopoverTrigger
							render={
								<Button
									aria-label="Choose cloud environment"
									className={WORKSPACE_SELECT_TRIGGER}
									size="sm"
									variant="ghost"
								/>
							}
						>
							{selected?.name ??
								(selection.environmentId
									? "Bound cloud environment"
									: "Choose environment")}
						</PopoverTrigger>
						<PopoverContent align="start" className="w-80">
							<div className="space-y-3">
								<Input
									aria-label="Search cloud environments"
									onChange={(event) => setSearch(event.target.value)}
									placeholder="Search environments"
									value={search}
								/>
								{loading ? (
									<p className="text-muted-foreground text-sm" role="status">
										Loading environments…
									</p>
								) : null}
								{error ? (
									<InlineErrorRow
										details={error}
										message="Couldn't load cloud environments."
										onRetry={() => setReload((value) => value + 1)}
									/>
								) : null}
								<div className="max-h-60 space-y-1 overflow-y-auto">
									{profiles
										.filter((profile) =>
											`${profile.name} ${profile.repositories.join(" ")}`
												.toLowerCase()
												.includes(search.toLowerCase())
										)
										.map((profile) => {
											const boxPreviewLocked =
												!boxBackendEnabled &&
												profile.runtime?.backend === "box";
											return (
												<Button
													className="w-full justify-start"
													disabled={locked || boxPreviewLocked}
													key={profile.id}
													onClick={() => {
														if (boxPreviewLocked) {
															return;
														}
														change({
															mode: "cloud",
															environmentId: profile.id,
															runtime: profile.runtime
																? {
																		backend: profile.runtime.backend,
																		executor: profile.runtime.executor,
																	}
																: null,
															locked: false,
														});
														setOpen(false);
													}}
													size="sm"
													variant={
														cloud && selection.environmentId === profile.id
															? "secondary"
															: "ghost"
													}
												>
													<span
														className="min-w-0 truncate"
														title={profile.name}
													>
														{profile.name}
													</span>
													{boxPreviewLocked ? (
														<span className="text-muted-foreground text-xs">
															Preview
														</span>
													) : null}
													{boxBackendEnabled &&
													profile.runtime?.backend === "box" ? (
														<span className="text-muted-foreground text-xs">
															Fresh box
														</span>
													) : null}
													{boxBackendEnabled &&
													profile.runtime &&
													profile.runtime.executor !== "ryu" ? (
														<span className="text-muted-foreground text-xs">
															{CLOUD_EXECUTOR_LABELS[profile.runtime.executor]}
														</span>
													) : null}
												</Button>
											);
										})}
								</div>
								{loading ||
								error ||
								profiles.some((profile) =>
									`${profile.name} ${profile.repositories.join(" ")}`
										.toLowerCase()
										.includes(search.toLowerCase())
								) ? null : (
									<p className="text-muted-foreground text-sm">
										{profiles.length
											? "No matching environments."
											: "No published environments yet."}
									</p>
								)}
								{locked ? (
									<p className="text-muted-foreground text-xs">
										This chat's environment is fixed. Start a new chat to choose
										another.
									</p>
								) : null}
								<div className="flex flex-wrap gap-2 border-t pt-3">
									<Button
										onClick={() => {
											setOpen(false);
											setRepositoryDraft(null);
											setManage("create");
										}}
										size="sm"
										variant="outline"
									>
										Create environment
									</Button>
									<Button
										onClick={() => {
											setOpen(false);
											setManage("manage");
										}}
										size="sm"
										variant="ghost"
									>
										Manage environments
									</Button>
									<Button
										onClick={() => {
											setOpen(false);
											setGithubOpen(true);
										}}
										size="sm"
										variant="ghost"
									>
										Connect GitHub
									</Button>
								</div>
							</div>
						</PopoverContent>
					</Popover>
				) : null}
				{selection.mode === "loading" ? (
					<p className="text-detail text-muted-foreground" role="status">
						Loading chat environment…
					</p>
				) : null}
				{selection.mode === "error" ? (
					// One sentence plus Retry; the raw failure (status line, URL)
					// stays behind "Copy details".
					<InlineErrorRow
						details={selection.message}
						message="Couldn't load the chat environment."
						onRetry={onRetry}
					/>
				) : null}
			</div>
			<Dialog
				onOpenChange={(next) => {
					if (!next) {
						setManage(null);
						setReload((value) => value + 1);
					}
				}}
				open={manage !== null}
			>
				<DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl">
					<DialogHeader>
						<DialogTitle>Cloud environments</DialogTitle>
						<DialogDescription>
							Configure and publish an environment on this node before starting
							a cloud task.
						</DialogDescription>
					</DialogHeader>
					{manage ? (
						<Suspense fallback={null}>
							<CloudEnvironmentsSettings
								initialRepository={repositoryDraft?.repository}
								initialVaultKey={repositoryDraft?.vaultKey}
								startCreate={manage === "create"}
								target={target}
							/>
						</Suspense>
					) : null}
				</DialogContent>
			</Dialog>
			{githubOpen ? (
				<CloudGithubConnectionDialog
					onClose={() => {
						setGithubOpen(false);
						setReload((value) => value + 1);
					}}
					onRepository={(repository, vaultKey) => {
						setGithubOpen(false);
						setRepositoryDraft({ repository, vaultKey });
						setManage("create");
					}}
					target={target}
				/>
			) : null}
		</>
	);
}
