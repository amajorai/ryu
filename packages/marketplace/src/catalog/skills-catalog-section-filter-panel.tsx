import {
	Add01Icon,
	ArrowDown01Icon,
	ArrowUp01Icon,
	Delete01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { useState } from "react";
import { type ActiveChip, FilterChipBar } from "./chrome/catalog-badges.tsx";
import type {
	AddMarketplaceParams,
	MarketplaceMoveDirection,
	SkillCatalogSource,
	SkillSort,
} from "./types.ts";

/**
 * Sort options for the skills list. The skills.sh directory carries no category
 * taxonomy (only install counts), so sort — not a category filter — is what's
 * applicable here.
 */
const SORT_OPTIONS: { value: SkillSort; label: string }[] = [
	{ value: "popular", label: "Most installed" },
	{ value: "name", label: "Name (A–Z)" },
];

/** Filter popover: sort + source picker + friendly/installed switches + chips.
 *  The search box itself lives directly in the toolbar (see the layout's `search`
 *  prop); this is the "Filters" popover beside it. */
export function SkillsFilterPanel({
	sort,
	setSort,
	sources,
	addMarketplace,
	addingMarketplace,
	removeMarketplace,
	reorderMarketplace,
	friendly,
	setFriendly,
	installedOnly,
	setInstalledOnly,
	showInstalledOnly,
	onCreate,
	canAuthor,
	chips,
}: {
	sort: SkillSort;
	setSort: (s: SkillSort) => void;
	sources: SkillCatalogSource[];
	addMarketplace: (params: AddMarketplaceParams) => Promise<void>;
	addingMarketplace: boolean;
	removeMarketplace: (id: string) => Promise<void>;
	reorderMarketplace: (
		id: string,
		direction: MarketplaceMoveDirection
	) => Promise<void>;
	friendly: boolean;
	setFriendly: (v: boolean) => void;
	installedOnly: boolean;
	setInstalledOnly: (v: boolean) => void;
	showInstalledOnly: boolean;
	onCreate: () => void;
	canAuthor: boolean;
	chips: ActiveChip[];
}) {
	return (
		<div className="flex flex-col gap-3 p-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex flex-wrap items-center gap-2">
					{canAuthor ? (
						<Button onClick={onCreate} size="sm" variant="ghost">
							<HugeiconsIcon className="size-4" icon={Add01Icon} />
							New skill
						</Button>
					) : null}
					<Select<SkillSort>
						items={SORT_OPTIONS}
						onValueChange={(v) => setSort(v)}
						value={sort}
					>
						<SelectTrigger className="h-8 w-[150px]" size="sm">
							<SelectValue placeholder="Sort" />
						</SelectTrigger>
						<SelectContent>
							{SORT_OPTIONS.map((opt) => (
								<SelectItem key={opt.value} value={opt.value}>
									{opt.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<SkillSourcePicker
						addingMarketplace={addingMarketplace}
						addMarketplace={addMarketplace}
						removeMarketplace={removeMarketplace}
						reorderMarketplace={reorderMarketplace}
						sources={sources}
					/>
				</div>
				<div className="flex items-center gap-4 text-sm">
					<div className="flex items-center gap-2">
						<Switch
							aria-label="Friendly names"
							checked={friendly}
							id="friendly-skills"
							onCheckedChange={setFriendly}
						/>
						<label className="cursor-pointer" htmlFor="friendly-skills">
							Friendly names
						</label>
					</div>
					{showInstalledOnly ? (
						<div className="flex items-center gap-2">
							<Switch
								aria-label="Show only installed skills"
								checked={installedOnly}
								id="skills-installed-only"
								onCheckedChange={setInstalledOnly}
							/>
							<label className="cursor-pointer" htmlFor="skills-installed-only">
								Added only
							</label>
						</div>
					) : null}
				</div>
			</div>
			<FilterChipBar chips={chips} />
		</div>
	);
}

/**
 * Marketplace management popover. The catalog always shows every source; this
 * control is only for adding a custom marketplace and maintaining its order.
 */
function SkillSourcePicker({
	sources,
	addMarketplace,
	addingMarketplace,
	removeMarketplace,
	reorderMarketplace,
}: {
	sources: SkillCatalogSource[];
	addMarketplace: (params: AddMarketplaceParams) => Promise<void>;
	addingMarketplace: boolean;
	removeMarketplace: (id: string) => Promise<void>;
	reorderMarketplace: (
		id: string,
		direction: MarketplaceMoveDirection
	) => Promise<void>;
}) {
	const tl = useLiteralMessages();
	const [open, setOpen] = useState(false);
	const [repo, setRepo] = useState("");
	const [name, setName] = useState("");
	const [addError, setAddError] = useState<string | null>(null);
	const [sourceActionId, setSourceActionId] = useState<string | null>(null);
	const customSources = sources.filter((source) => !source.builtin);

	const submit = async () => {
		const trimmedRepo = repo.trim();
		if (!trimmedRepo) {
			setAddError("Enter a repo, git URL, or local path");
			return;
		}
		const displayName = name.trim() || trimmedRepo;
		// Derive a stable, safe id from the display name / repo.
		const id = `mp-${displayName
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")}`;
		setAddError(null);
		try {
			await addMarketplace({ id, displayName, baseUrl: trimmedRepo });
			setRepo("");
			setName("");
			setOpen(false);
		} catch (e) {
			setAddError(e instanceof Error ? e.message : "Failed to add marketplace");
		}
	};

	const runSourceAction = async (id: string, action: () => Promise<void>) => {
		setSourceActionId(id);
		setAddError(null);
		try {
			await action();
		} catch (e) {
			setAddError(
				e instanceof Error ? e.message : "Failed to update marketplace"
			);
		} finally {
			setSourceActionId(null);
		}
	};

	return (
		<div className="flex items-center gap-2">
			<Popover onOpenChange={setOpen} open={open}>
				<Tooltip>
					<TooltipTrigger
						render={
							<PopoverTrigger
								className="inline-flex h-8 items-center"
								variant="marketplace-add"
							>
								<HugeiconsIcon className="size-4" icon={Add01Icon} />
								Add marketplace
							</PopoverTrigger>
						}
					/>
					<TooltipContent>Add or manage skill marketplaces</TooltipContent>
				</Tooltip>
				<PopoverContent className="w-[24rem]">
					<div className="flex flex-col gap-4">
						<div className="flex flex-col gap-1">
							<p className="font-medium text-sm">Marketplaces</p>
							<p className="text-muted-foreground text-xs">
								All registered sources are shown in the catalog. Custom
								marketplaces can be reordered or removed here.
							</p>
						</div>
						<div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
							{sources.map((source) => {
								const customIndex = customSources.findIndex(
									(item) => item.id === source.id
								);
								const manageable = !source.builtin;
								const busy = sourceActionId === source.id;
								return (
									<div
										className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-accent"
										key={source.id}
									>
										<div className="min-w-0 flex-1">
											<p
												className="truncate text-sm"
												title={source.displayName}
											>
												{source.displayName}
											</p>
											<p className="text-muted-foreground text-xs">
												{manageable
													? "Custom marketplace"
													: "Built-in registry"}
											</p>
										</div>
										{manageable ? (
											<div className="flex shrink-0 items-center gap-0.5">
												<Button
													aria-label={tl("Move {displayName} up", {
														displayName: source.displayName,
													})}
													disabled={sourceActionId !== null || customIndex <= 0}
													onClick={() => {
														runSourceAction(source.id, () =>
															reorderMarketplace(source.id, "up")
														).catch(() => undefined);
													}}
													size="icon"
													variant="ghost"
												>
													<HugeiconsIcon
														className="size-4"
														icon={ArrowUp01Icon}
													/>
												</Button>
												<Button
													aria-label={tl("Move {displayName} down", {
														displayName: source.displayName,
													})}
													disabled={
														sourceActionId !== null ||
														customIndex === customSources.length - 1
													}
													onClick={() => {
														runSourceAction(source.id, () =>
															reorderMarketplace(source.id, "down")
														).catch(() => undefined);
													}}
													size="icon"
													variant="ghost"
												>
													<HugeiconsIcon
														className="size-4"
														icon={ArrowDown01Icon}
													/>
												</Button>
												<Button
													aria-label={tl("Delete {displayName}", {
														displayName: source.displayName,
													})}
													disabled={sourceActionId !== null}
													loading={busy}
													onClick={() => {
														runSourceAction(source.id, () =>
															removeMarketplace(source.id)
														).catch(() => undefined);
													}}
													size="icon"
													variant="ghost"
												>
													{!busy && (
														<HugeiconsIcon
															className="size-4"
															icon={Delete01Icon}
														/>
													)}
												</Button>
											</div>
										) : (
											<span className="shrink-0 text-muted-foreground text-xs">
												Built-in
											</span>
										)}
									</div>
								);
							})}
						</div>
						<div className="flex flex-col gap-3 border-t pt-3">
							<div className="flex flex-col gap-1">
								<p className="font-medium text-sm">Add marketplace</p>
								<p className="text-muted-foreground text-xs">
									Connect a repo, git URL, or local marketplace path.
								</p>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor="mp-repo">Repo, git URL, or local path</Label>
								<Input
									id="mp-repo"
									onChange={(e) => setRepo(e.target.value)}
									placeholder="owner/repo or /path/to/marketplace"
									value={repo}
								/>
							</div>
							<div className="flex flex-col gap-1">
								<Label htmlFor="mp-name">Display name (optional)</Label>
								<Input
									id="mp-name"
									onChange={(e) => setName(e.target.value)}
									placeholder="My Marketplace"
									value={name}
								/>
							</div>
							{addError && (
								<p className="text-status-destructive text-xs">{addError}</p>
							)}
							<Button
								disabled={sourceActionId !== null}
								loading={addingMarketplace}
								onClick={() => {
									submit().catch(() => undefined);
								}}
								size="sm"
							>
								{!addingMarketplace && (
									<HugeiconsIcon className="size-4" icon={Add01Icon} />
								)}
								{addingMarketplace ? "Adding…" : "Add marketplace"}
							</Button>
						</div>
					</div>
				</PopoverContent>
			</Popover>
		</div>
	);
}
