// apps/desktop/src/components/chat/WorkspacePicker-branch-list.tsx
//
// WorkspacePicker's branch command list and its create-branch dialog.

import {
	Add01Icon,
	ArrowDown01Icon,
	WorkflowCircle06Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandLoading,
	CommandSeparator,
} from "@ryu/ui/components/command.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { useCallback, useId, useState } from "react";

// How many branches the list renders before it stops and offers "show all". A
// repo with hundreds of branches would otherwise mount hundreds of menu rows on
// every open — and nobody scrolls past the first screen anyway. Core sorts by
// most-recent commit, so the visible head is the branches actually in play; the
// search box filters the FULL list, so a capped-away branch is always one query
// away (filter first, cap the filtered result — capping first would hide rows
// from search, which is the trap this affordance exists to avoid).
const BRANCH_PAGE = 50;

export function BranchList({
	branches,
	branch,
	changedFiles,
	loading,
	switching,
	error,
	dirty,
	onClose,
	onSwitch,
	onStartCreate,
	projectName,
}: {
	branches: string[];
	branch: string | null;
	changedFiles: number;
	loading: boolean;
	switching: string | null;
	error: string | null;
	/** Working tree has uncommitted changes — creating a branch is disabled. */
	dirty: boolean;
	onClose: () => void;
	onSwitch: (b: string) => void;
	/** Opens the create-branch dialog (owned by the persistent parent). */
	onStartCreate: () => void;
	projectName: string | null;
}) {
	const tl = useLiteralMessages();
	const dirtyReasonId = useId();
	const [query, setQuery] = useState("");
	const [showAll, setShowAll] = useState(false);

	if (loading) {
		return (
			<CommandList>
				<CommandLoading label="Loading branches">
					<SkeletonRows spacing="spacious" />
				</CommandLoading>
			</CommandList>
		);
	}
	if (branches.length === 0) {
		return (
			<CommandList>
				<CommandEmpty>No branches found.</CommandEmpty>
			</CommandList>
		);
	}

	const q = query.trim().toLowerCase();
	const filtered = q
		? branches.filter((b) => b.toLowerCase().includes(q))
		: branches;
	const visible = showAll ? filtered : filtered.slice(0, BRANCH_PAGE);
	const hidden = filtered.length - visible.length;

	return (
		<>
			{branches.length > 1 && (
				<CommandInput
					onValueChange={setQuery}
					placeholder={
						projectName
							? tl("Search {projectName} branches", { projectName })
							: "Search branches"
					}
					spellCheck={false}
					value={query}
				/>
			)}
			{/* Status and error text stay outside the listbox, which may only own
			    options and groups. The create-branch row keeps the list non-empty,
			    so cmdk's CommandEmpty cannot carry "No matching branches." */}
			{error && (
				<p className="px-2 py-1.5 text-status-destructive text-xs" role="alert">
					{error}
				</p>
			)}
			{filtered.length === 0 && (
				<p className="px-2 py-1.5 text-muted-foreground text-sm" role="status">
					No matching branches.
				</p>
			)}
			<CommandList className="max-h-[min(60vh,520px)]">
				<CommandGroup heading="Branches">
					{visible.map((b) => {
						const isActive = b === branch;
						return (
							<CommandItem
								data-checked={isActive}
								disabled={switching !== null}
								key={b}
								onSelect={() => (isActive ? onClose() : onSwitch(b))}
								value={`branch:${b}`}
							>
								<HugeiconsIcon
									className="size-4 shrink-0 text-muted-foreground"
									icon={WorkflowCircle06Icon}
								/>
								<span className="min-w-0 flex-1">
									<span className="block truncate">{b}</span>
									{isActive && changedFiles > 0 && (
										<span className="block truncate font-normal text-muted-foreground text-xs">
											{tl(
												"{changedFiles, plural, one {Uncommitted: {fileCount} file} other {Uncommitted: {fileCount} files}}",
												{ changedFiles, fileCount: formatCount(changedFiles) }
											)}
										</span>
									)}
								</span>
								{switching === b && <Spinner className="size-4 shrink-0" />}
							</CommandItem>
						);
					})}
					{hidden > 0 && (
						<CommandItem
							onSelect={() => setShowAll(true)}
							value="action:show-all-branches"
						>
							<HugeiconsIcon
								className="size-4 shrink-0 text-muted-foreground"
								icon={ArrowDown01Icon}
							/>
							<span className="flex-1 text-muted-foreground">
								{tl(
									"{hidden, plural, one {Show {hiddenCount} more branch} other {Show {hiddenCount} more branches}}",
									{ hidden, hiddenCount: String(hidden) }
								)}
							</span>
						</CommandItem>
					)}
				</CommandGroup>
				<CommandSeparator />
				<CommandGroup>
					{/* A dirty tree blocks branch creation; otherwise the row opens the
					    dialog (which outlives this picker). */}
					<CommandItem
						aria-describedby={dirty ? dirtyReasonId : undefined}
						disabled={dirty}
						onSelect={onStartCreate}
						value="action:create-branch"
					>
						<HugeiconsIcon
							className="size-4 shrink-0 text-muted-foreground"
							icon={Add01Icon}
						/>
						<span className="flex-1">Create a new branch</span>
					</CommandItem>
					{dirty && (
						<p
							className="type-caption px-2 py-1 text-muted-foreground"
							id={dirtyReasonId}
							role="note"
						>
							Commit those changes first
						</p>
					)}
				</CommandGroup>
			</CommandList>
		</>
	);
}

/** Dialog to name and create a new git branch off HEAD, then switch to it.
 *  Controlled + rendered by WorkspacePicker so it outlives the branch picker. */
export function CreateBranchDialog({
	open: dialogOpen,
	onOpenChange,
	onCreate,
	creating,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Create a branch; resolves to an error string, or null on success. */
	onCreate: (name: string) => Promise<string | null>;
	creating: boolean;
}) {
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);

	const handleCreate = useCallback(async () => {
		const trimmed = name.trim();
		if (!trimmed || creating) {
			return;
		}
		setError(null);
		const err = await onCreate(trimmed);
		if (err) {
			setError(err);
		} else {
			setName("");
			onOpenChange(false);
		}
	}, [name, creating, onCreate, onOpenChange]);

	return (
		<Dialog onOpenChange={onOpenChange} open={dialogOpen}>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>Create a new branch</DialogTitle>
					<DialogDescription>
						Branch off the current HEAD and switch to it.
					</DialogDescription>
				</DialogHeader>
				<Input
					aria-label="Branch name"
					// dialog opened by explicit user action; focusing the sole field is expected
					autoFocus
					disabled={creating}
					onChange={(e) => {
						setName(e.target.value);
						setError(null);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							handleCreate();
						}
					}}
					placeholder="feature/my-branch"
					spellCheck={false}
					value={name}
					variant="code"
				/>
				{error && <p className="text-status-destructive text-xs">{error}</p>}
				<DialogFooter>
					<DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
					<Button
						disabled={name.trim().length === 0}
						loading={creating}
						onClick={handleCreate}
						type="button"
					>
						Create branch
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
