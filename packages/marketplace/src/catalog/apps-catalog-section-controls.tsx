import { Add01Icon, Link01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
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
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { useState } from "react";
import {
	type AddMarketplaceParams,
	ALL_PLUGIN_SOURCES_ID,
	type PluginCatalogSource,
} from "./types.ts";

export function TagFilter({
	onChange,
	tags,
	value,
}: {
	onChange: (value: string | null) => void;
	tags: string[];
	value: string | null;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<span className="font-medium text-muted-foreground text-xs">Tag</span>
			<Select
				items={[
					{ value: "__all__", label: "All tags" },
					...tags.map((tag) => ({ value: tag, label: tag })),
				]}
				onValueChange={(next) =>
					onChange(next === "__all__" ? null : (next ?? null))
				}
				value={value ?? "__all__"}
			>
				<SelectTrigger className="h-8 w-full" size="sm">
					<SelectValue placeholder="All tags" />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="__all__">All tags</SelectItem>
					{tags.map((tag) => (
						<SelectItem key={tag} value={tag}>
							{tag}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

/**
 * Source dropdown (Ryu Marketplace + any custom Claude plugin marketplaces) plus
 * an "Add marketplace" popover. A marketplace is a repo/URL/local directory
 * pointing at a `marketplace.json` (`.claude-plugin/`, `.ryu-plugin/`, …).
 */
export function PluginSourcePicker({
	sources,
	activeSource,
	selectSource,
	selectingSource,
	addMarketplace,
	addingMarketplace,
}: {
	sources: PluginCatalogSource[];
	activeSource: string;
	selectSource: (id: string) => void;
	selectingSource: boolean;
	addMarketplace: (params: AddMarketplaceParams) => Promise<void>;
	addingMarketplace: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [repo, setRepo] = useState("");
	const [name, setName] = useState("");
	const [addError, setAddError] = useState<string | null>(null);

	// "All marketplaces" leads, and is the default the store opens on. The picker is
	// a NARROWING control now, not the thing that decides whether a listing is
	// findable at all: every source is already on screen under its own heading, so
	// choosing one here is for focusing (or for paging through a big federated feed,
	// which the all view cannot cursor across).
	const sourceItems = [
		{ value: ALL_PLUGIN_SOURCES_ID, label: "All marketplaces" },
		...sources.map((s) => ({ value: s.id, label: s.displayName })),
	];

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

	return (
		<div className="flex flex-col gap-1.5">
			<span className="font-medium text-muted-foreground text-xs">
				Catalog source
			</span>
			{/* One real source still earns the picker: the choice on offer is now
			    "everything" vs "just this one", which is a choice even with a single
			    marketplace registered. It only collapses when there is nothing at all
			    to narrow to. */}
			{sourceItems.length > 1 && (
				<Select
					disabled={selectingSource}
					items={sourceItems}
					onValueChange={(value) => {
						if (value) {
							selectSource(value);
						}
					}}
					value={activeSource}
				>
					<SelectTrigger className="h-8 w-full" size="sm">
						<SelectValue placeholder="Source" />
					</SelectTrigger>
					<SelectContent>
						{sourceItems.map((opt) => (
							<SelectItem key={opt.value} value={opt.value}>
								{opt.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}
			<Popover onOpenChange={setOpen} open={open}>
				<TooltipProvider delay={0}>
					<Tooltip>
						<TooltipTrigger
							render={
								<PopoverTrigger
									className="inline-flex h-8 w-full items-center"
									variant="marketplace-add"
								>
									<HugeiconsIcon className="size-4" icon={Add01Icon} />
									Add marketplace
								</PopoverTrigger>
							}
						/>
						<TooltipContent>Add a Claude plugin marketplace</TooltipContent>
					</Tooltip>
				</TooltipProvider>
				<PopoverContent className="w-80">
					<div className="flex flex-col gap-3">
						<div className="flex flex-col gap-1">
							<Label htmlFor="plugin-mp-repo">
								Repo, git URL, or local path
							</Label>
							<Input
								id="plugin-mp-repo"
								onChange={(e) => setRepo(e.target.value)}
								placeholder="owner/repo, https://…/marketplace.json, or /path/to/marketplace"
								value={repo}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<Label htmlFor="plugin-mp-name">Display name (optional)</Label>
							<Input
								id="plugin-mp-name"
								onChange={(e) => setName(e.target.value)}
								placeholder="My Marketplace"
								value={name}
							/>
						</div>
						{addError && (
							<p className="text-status-destructive text-xs">{addError}</p>
						)}
						<Button
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
				</PopoverContent>
			</Popover>
		</div>
	);
}

export function InstallFromUrl({
	error,
	install,
}: {
	error: string | null;
	install: (url: string) => Promise<void>;
}) {
	const [url, setUrl] = useState("");
	const [busy, setBusy] = useState(false);

	// Fire-and-forget: all errors are handled inside, so the returned promise
	// never rejects and callers can invoke it without awaiting or `void`.
	const submit = () => {
		const trimmed = url.trim();
		if (!trimmed || busy) {
			return;
		}
		setBusy(true);
		install(trimmed)
			.then(() => setUrl(""))
			.catch(() => {
				// Error is shown next to the input; the value stays populated for retry.
			})
			.finally(() => setBusy(false));
	};

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center gap-2">
				<div className="relative flex-1">
					<HugeiconsIcon
						className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
						icon={Link01Icon}
					/>
					<Input
						aria-label="App manifest URL"
						leadingAdornment="default"
						onChange={(e) => setUrl(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								submit();
							}
						}}
						placeholder="https://…/manifest.json"
						value={url}
					/>
				</div>
				<Button
					disabled={url.trim().length === 0}
					loading={busy}
					onClick={submit}
					size="sm"
					variant="ghost"
				>
					Add from URL
				</Button>
			</div>
			{error ? (
				<p className="text-status-destructive text-xs" role="alert">
					{error}
				</p>
			) : null}
		</div>
	);
}
