// apps/desktop/src/components/PromptLibrary.tsx
//
// The prompt library inside Prompt Studio: browse the node's prompt registry
// (prompts authored on this node plus the read-only mirror of the
// organization registry), read and compare immutable versions, move labels,
// commit the editor text as a new version, and load a version into the agent's
// system prompt. Data comes from Core's `/api/prompts` routes.

import {
	GitCompareIcon,
	LibraryIcon,
	RefreshIcon,
	Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
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
import { Label } from "@ryu/ui/components/label.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { ScrollArea } from "@ryu/ui/components/scroll-area.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, type ApiTarget } from "@/src/lib/api/client.ts";
import {
	commitPromptVersion,
	createPrompt,
	listPrompts,
	listPromptVersions,
	movePromptLabel,
	type PromptList,
	type PromptSummary,
	type PromptVersion,
	syncPrompts,
} from "@/src/lib/api/prompts.ts";
import {
	assignableLabel,
	editorCommitDraft,
	filterPrompts,
	instructionsFromVersion,
	isEditablePrompt,
	versionDiffRows,
} from "@/src/lib/prompt-library.ts";
import { PromptLibraryPromptList } from "./PromptLibrary-prompt-list.tsx";
import { PromptLibraryVersionPanel } from "./PromptLibrary-version-panel.tsx";

export interface PromptLibraryProps {
	/** The editor's current system prompt (committed or saved as a prompt). */
	currentPrompt: string;
	/** Whether the agent is locked; loading a version is then disabled. */
	locked: boolean;
	/** Replace the agent's system prompt with a version's instructions. */
	onUsePrompt: (instructions: string) => void;
	target: ApiTarget;
}

function message(error: unknown, fallback: string): string {
	if (error instanceof ApiError) {
		return error.serverMessage ?? error.message;
	}
	return error instanceof Error ? error.message : fallback;
}

export function PromptLibrary({
	currentPrompt,
	locked,
	onUsePrompt,
	target,
}: PromptLibraryProps) {
	const tl = useLiteralMessages();
	const [open, setOpen] = useState(false);
	const [list, setList] = useState<PromptList | null>(null);
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [selectedName, setSelectedName] = useState<string | null>(null);
	const [versions, setVersions] = useState<PromptVersion[]>([]);
	const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
	const [compareTo, setCompareTo] = useState<number | null>(null);
	const [newName, setNewName] = useState("");
	const [commitMessage, setCommitMessage] = useState("");
	const [labelDraft, setLabelDraft] = useState("production");

	const reload = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			setList(await listPrompts(target));
		} catch (caught) {
			setError(message(caught, "Failed to load prompts"));
		} finally {
			setLoading(false);
		}
	}, [target]);

	useEffect(() => {
		if (open) {
			reload().catch(() => undefined);
		}
	}, [open, reload]);

	const loadVersions = useCallback(
		async (name: string) => {
			setError(null);
			try {
				const page = await listPromptVersions(target, name);
				setVersions(page.versions);
				setSelectedVersion(page.versions[0]?.version ?? null);
				setCompareTo(null);
			} catch (caught) {
				setError(message(caught, "Failed to load versions"));
			}
		},
		[target]
	);

	useEffect(() => {
		if (selectedName) {
			loadVersions(selectedName).catch(() => undefined);
		} else {
			setVersions([]);
			setSelectedVersion(null);
		}
	}, [selectedName, loadVersions]);

	const prompts = useMemo(
		() => filterPrompts(list?.prompts ?? [], query),
		[list, query]
	);
	const selected: PromptSummary | undefined = list?.prompts.find(
		(prompt) => prompt.name === selectedName
	);
	const current = versions.find((entry) => entry.version === selectedVersion);
	const other = versions.find((entry) => entry.version === compareTo);
	const diff = useMemo(
		() => (current && other ? versionDiffRows(other, current) : null),
		[current, other]
	);
	const editable = selected ? isEditablePrompt(selected) : false;

	const run = useCallback(
		async (action: () => Promise<void>, fallback: string) => {
			setBusy(true);
			setError(null);
			try {
				await action();
			} catch (caught) {
				setError(message(caught, fallback));
			} finally {
				setBusy(false);
			}
		},
		[]
	);

	const handleSync = () =>
		run(async () => {
			const result = await syncPrompts(target);
			if (!result.synced) {
				setError(result.reason ?? "This node is not signed in");
			}
			await reload();
		}, "Failed to sync organization prompts");

	const handleSaveAsNew = () =>
		run(async () => {
			const name = newName.trim();
			await createPrompt(target, {
				name,
				version: {
					type: "text",
					template: currentPrompt,
					commitMessage: commitMessage.trim() || undefined,
				},
			});
			setNewName("");
			setCommitMessage("");
			await reload();
			setSelectedName(name);
		}, "Failed to save the prompt");

	const handleCommit = () =>
		run(async () => {
			const latest = versions[0];
			if (!(selected && latest && latest.name === selected.name)) {
				return;
			}
			try {
				await commitPromptVersion(target, selected.name, {
					...editorCommitDraft(latest, currentPrompt),
					commitMessage: commitMessage.trim() || undefined,
				});
			} catch (caught) {
				// A conflict means a newer version landed; show it before a retry.
				await loadVersions(selected.name);
				throw caught;
			}
			setCommitMessage("");
			await reload();
			await loadVersions(selected.name);
		}, "Failed to commit a new version");

	const handleLabel = () =>
		run(async () => {
			const label = assignableLabel(labelDraft);
			if (!(selected && current && label)) {
				setError("Labels are lowercase letters, digits, - and _ (not latest)");
				return;
			}
			await movePromptLabel(target, selected.name, label, current.version);
			await reload();
			await loadVersions(selected.name);
			setSelectedVersion(current.version);
		}, "Failed to move the label");

	const handleUse = () => {
		if (current) {
			onUsePrompt(instructionsFromVersion(current));
			setOpen(false);
		}
	};

	return (
		<>
			<Button
				onClick={() => setOpen(true)}
				size="sm"
				typography="compact"
				variant="ghost"
			>
				<HugeiconsIcon className="size-3" icon={LibraryIcon} />
				Prompt library
			</Button>
			<Dialog onOpenChange={setOpen} open={open}>
				<DialogContent className="sm:max-w-4xl">
					<DialogHeader>
						<DialogTitle>Prompt library</DialogTitle>
						<DialogDescription>
							{list?.organizationId
								? tl(
										"Versioned prompts on this node, including your organization's prompts. Versions never change; labels such as production point at the version agents should use."
									)
								: tl(
										"Versioned prompts on this node. Versions never change; labels such as production point at the version agents should use."
									)}
						</DialogDescription>
					</DialogHeader>

					{error ? (
						<p className="text-status-destructive text-xs" role="alert">
							{error}
						</p>
					) : null}

					<div className="grid min-h-0 grid-cols-1 gap-4 md:grid-cols-[16rem_1fr]">
						<div className="flex min-h-0 flex-col gap-2">
							<div className="relative">
								<HugeiconsIcon
									aria-hidden="true"
									className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
									icon={Search01Icon}
								/>
								<Input
									aria-label="Search prompts"
									leadingAdornment="default"
									onInput={(event) => setQuery(event.currentTarget.value)}
									placeholder="Search prompts"
									role="searchbox"
									size="compact"
									type="search"
									value={query}
								/>
							</div>
							<ScrollArea className="max-h-[min(50vh,24rem)]">
								{loading ? (
									<SkeletonRows label="Loading prompts…" />
								) : prompts.length === 0 ? (
									<p className="p-2 text-muted-foreground text-xs">
										No prompts yet. Save the editor text as a prompt below.
									</p>
								) : (
									<PromptLibraryPromptList
										prompts={prompts}
										selectedName={selectedName}
										setSelectedName={setSelectedName}
									/>
								)}
							</ScrollArea>
							{list?.organizationId ? (
								<div className="flex flex-col gap-1">
									<Button
										loading={busy}
										onClick={handleSync}
										size="sm"
										typography="compact"
										variant="ghost"
									>
										<HugeiconsIcon className="size-3" icon={RefreshIcon} />
										Sync organization prompts
									</Button>
									{list.sync.lastError ? (
										<p className="text-muted-foreground text-xs">
											Last sync failed; showing the saved copy.
										</p>
									) : null}
								</div>
							) : null}
							<div className="flex flex-col gap-1 border-t pt-2">
								<Label htmlFor="prompt-library-new-name" size="compact">
									Save editor text as a new prompt
								</Label>
								<Input
									autoComplete="off"
									id="prompt-library-new-name"
									onChange={(event) => setNewName(event.target.value)}
									placeholder="prompt-name"
									size="compact"
									value={newName}
								/>
								<Button
									disabled={!(newName.trim() && currentPrompt.trim()) || busy}
									onClick={handleSaveAsNew}
									size="sm"
									typography="compact"
									variant="secondary"
								>
									Save as prompt
								</Button>
							</div>
						</div>

						<div className="flex min-h-0 min-w-0 flex-col gap-3">
							{selected ? (
								<>
									<div className="flex flex-wrap items-center gap-2">
										<span className="font-medium text-sm">{selected.name}</span>
										{selected.description ? (
											<span className="text-muted-foreground text-xs">
												{selected.description}
											</span>
										) : null}
										<div className="ml-auto flex items-center gap-2">
											<Label htmlFor="prompt-library-version" size="compact">
												Version
											</Label>
											<NativeSelect
												appearance="compact"
												id="prompt-library-version"
												onChange={(event) =>
													setSelectedVersion(Number(event.target.value))
												}
												value={selectedVersion ?? ""}
											>
												{versions.map((entry) => (
													<NativeSelectOption
														key={entry.version}
														value={entry.version}
													>
														v{entry.version}
														{entry.labels.length > 0
															? ` (${entry.labels.join(", ")})`
															: ""}
													</NativeSelectOption>
												))}
											</NativeSelect>
											<Label htmlFor="prompt-library-compare" size="compact">
												<HugeiconsIcon
													className="size-3"
													icon={GitCompareIcon}
												/>
												Compare
											</Label>
											<NativeSelect
												appearance="compact"
												id="prompt-library-compare"
												onChange={(event) =>
													setCompareTo(
														event.target.value === ""
															? null
															: Number(event.target.value)
													)
												}
												value={compareTo ?? ""}
											>
												<NativeSelectOption value="">None</NativeSelectOption>
												{versions
													.filter((entry) => entry.version !== selectedVersion)
													.map((entry) => (
														<NativeSelectOption
															key={entry.version}
															value={entry.version}
														>
															v{entry.version}
														</NativeSelectOption>
													))}
											</NativeSelect>
										</div>
									</div>

									{current ? (
										<PromptLibraryVersionPanel
											busy={busy}
											current={current}
											diff={diff}
											editable={editable}
											handleLabel={handleLabel}
											handleUse={handleUse}
											labelDraft={labelDraft}
											locked={locked}
											setLabelDraft={setLabelDraft}
										/>
									) : (
										<SkeletonRows label="Loading versions…" />
									)}

									{editable ? (
										<div className="flex flex-col gap-1 border-t pt-2">
											<Label htmlFor="prompt-library-commit" size="compact">
												Commit the editor text as a new version
											</Label>
											<div className="flex gap-2">
												<Input
													autoComplete="off"
													id="prompt-library-commit"
													onChange={(event) =>
														setCommitMessage(event.target.value)
													}
													placeholder="What changed?"
													size="compact"
													value={commitMessage}
												/>
												<Button
													disabled={
														!currentPrompt.trim() ||
														busy ||
														versions.length === 0
													}
													onClick={handleCommit}
													size="sm"
													typography="compact"
													variant="secondary"
												>
													Commit
												</Button>
											</div>
										</div>
									) : null}
								</>
							) : (
								<p className="p-2 text-muted-foreground text-xs">
									Select a prompt to see its versions and labels.
								</p>
							)}
						</div>
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}
