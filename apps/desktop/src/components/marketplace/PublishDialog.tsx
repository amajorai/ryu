// apps/desktop/src/components/marketplace/PublishDialog.tsx
//
// Universal "Publish" dialog (Phase 5a): a Notion-style flow to publish your own
// Runnable (today: an agent) to the Ryu Marketplace from inside the desktop app.
// It collects the App-Store-style listing metadata (display name, kebab slug,
// tagline, description, category, example prompts, optional icon/screenshot URLs)
// and submits via the packaged publish body → POST /api/marketplace/publish,
// landing the item in the moderator's "pending review" queue.
//
// The dialog is deliberately kind-agnostic: it owns the listing FORM and hands a
// finished `PublishListing` to the injected `buildBody` callback, so the exact
// packaging (agent card vs. a future workflow) lives with the caller. That keeps
// this reusable when workflow publishing lands.
//
// Publishing requires sign-in (the server runs requireAuth); the dialog gates on
// `hasMarketplaceAuth()` and surfaces the "auth" MarketplaceError.

import { Rocket01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import { Spinner } from "@ryu/ui/components/spinner";
import { Textarea } from "@ryu/ui/components/textarea";
import { useCallback, useMemo, useState } from "react";
import {
	hasMarketplaceAuth,
	MarketplaceError,
	type PublishRequest,
	type PublishResult,
	publishRunnable,
} from "@/src/lib/api/marketplace.ts";
import type { PublishListing } from "@/src/lib/publish/packaging.ts";
import { toKebab } from "@/src/lib/publish/packaging.ts";

/** Split a textarea value into trimmed, non-empty lines (one entry per line). */
function linesOf(value: string): string[] {
	return value
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

export interface PublishDialogProps {
	/** Human label for the thing being published, e.g. "agent". Used in copy. */
	kindLabel: string;
	/** Default display name (from the Runnable). */
	defaultDisplayName: string;
	/** Default long description (from the Runnable), or empty. */
	defaultDescription?: string;
	/** Package the collected listing into the wire body. Owned by the caller so
	 *  the dialog stays kind-agnostic. */
	buildBody: (listing: PublishListing) => PublishRequest;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function PublishDialog({
	kindLabel,
	defaultDisplayName,
	defaultDescription = "",
	buildBody,
	open,
	onOpenChange,
}: PublishDialogProps) {
	const [displayName, setDisplayName] = useState(defaultDisplayName);
	const [slug, setSlug] = useState(toKebab(defaultDisplayName));
	const [slugEdited, setSlugEdited] = useState(false);
	const [tagline, setTagline] = useState("");
	const [description, setDescription] = useState(defaultDescription);
	const [category, setCategory] = useState("");
	const [examplePromptsText, setExamplePromptsText] = useState("");
	const [iconUrl, setIconUrl] = useState("");
	const [screenshotsText, setScreenshotsText] = useState("");

	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<PublishResult | null>(null);

	const signedIn = hasMarketplaceAuth();

	// The slug tracks the display name until the user overrides it, so the id
	// (`<namespace>.<slug>`) stays predictable without extra typing.
	const onDisplayNameChange = useCallback(
		(value: string) => {
			setDisplayName(value);
			if (!slugEdited) {
				setSlug(toKebab(value));
			}
		},
		[slugEdited]
	);

	const effectiveSlug = useMemo(() => toKebab(slug), [slug]);

	const handleSubmit = useCallback(async () => {
		if (!signedIn) {
			setError("Sign in to publish to the marketplace.");
			return;
		}
		if (!displayName.trim()) {
			setError("A display name is required.");
			return;
		}
		if (!effectiveSlug) {
			setError("A URL name is required (letters, numbers, and dashes).");
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			const listing: PublishListing = {
				displayName: displayName.trim(),
				slug: effectiveSlug,
				tagline,
				description,
				category,
				examplePrompts: linesOf(examplePromptsText),
				iconUrl,
				screenshots: linesOf(screenshotsText),
			};
			const body = buildBody(listing);
			const res = await publishRunnable(body);
			setResult(res);
		} catch (e) {
			if (e instanceof MarketplaceError && e.kind === "auth") {
				setError("Sign in to publish to the marketplace.");
			} else {
				setError(e instanceof Error ? e.message : "Failed to publish.");
			}
		} finally {
			setSubmitting(false);
		}
	}, [
		signedIn,
		displayName,
		effectiveSlug,
		tagline,
		description,
		category,
		examplePromptsText,
		iconUrl,
		screenshotsText,
		buildBody,
	]);

	// Reset the transient submit state whenever the dialog closes — by the Cancel
	// button, Esc, the X, or a backdrop click — so re-opening always starts on a
	// fresh form instead of a stale "Submitted for review" screen. The filled-in
	// listing fields are intentionally kept so an accidental close isn't
	// destructive.
	const handleOpenChange = useCallback(
		(next: boolean) => {
			if (!next) {
				setResult(null);
				setError(null);
			}
			onOpenChange(next);
		},
		[onOpenChange]
	);

	const close = useCallback(() => handleOpenChange(false), [handleOpenChange]);

	return (
		<Dialog onOpenChange={handleOpenChange} open={open}>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<HugeiconsIcon className="size-4" icon={Rocket01Icon} />
						Publish {kindLabel}
					</DialogTitle>
					<DialogDescription>
						Share this {kindLabel} on the Ryu Marketplace. Only the portable
						card is published — no API keys, credentials, identities, or local
						paths are ever included.
					</DialogDescription>
				</DialogHeader>

				{result ? (
					<div className="flex flex-col gap-3 py-2">
						<div className="rounded-2xl bg-secondary/60 p-4 text-sm">
							<p className="font-medium">Submitted for review</p>
							<p className="mt-1 text-muted-foreground">
								<span className="font-mono">{result.id}</span> is now pending
								moderation. It goes live on the marketplace once a moderator
								approves it.
							</p>
						</div>
						<DialogFooter>
							<Button onClick={close}>Done</Button>
						</DialogFooter>
					</div>
				) : (
					<div className="flex flex-col gap-4 py-1">
						{!signedIn ? (
							<p className="rounded-xl bg-destructive/10 p-3 text-destructive text-sm">
								Sign in to your Ryu account to publish to the marketplace.
							</p>
						) : null}

						<div className="flex flex-col gap-1.5">
							<Label htmlFor="publish-name">Display name</Label>
							<Input
								id="publish-name"
								onChange={(e) => onDisplayNameChange(e.target.value)}
								placeholder="Research Assistant"
								value={displayName}
							/>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label htmlFor="publish-slug">URL name</Label>
							<Input
								id="publish-slug"
								onChange={(e) => {
									setSlug(e.target.value);
									setSlugEdited(true);
								}}
								placeholder="research-assistant"
								value={slug}
							/>
							<p className="text-muted-foreground text-xs">
								Lowercase letters, numbers, and dashes. Used in the listing's
								unique id.
							</p>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label htmlFor="publish-tagline">Tagline</Label>
							<Input
								id="publish-tagline"
								onChange={(e) => setTagline(e.target.value)}
								placeholder="A one-line pitch shown under the name"
								value={tagline}
							/>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label htmlFor="publish-description">Description</Label>
							<Textarea
								className="min-h-24"
								id="publish-description"
								onChange={(e) => setDescription(e.target.value)}
								placeholder="What does it do, and when should someone use it?"
								value={description}
							/>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label htmlFor="publish-category">Category</Label>
							<Input
								id="publish-category"
								onChange={(e) => setCategory(e.target.value)}
								placeholder="Productivity"
								value={category}
							/>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label htmlFor="publish-prompts">Example prompts</Label>
							<Textarea
								className="min-h-20"
								id="publish-prompts"
								onChange={(e) => setExamplePromptsText(e.target.value)}
								placeholder={"One per line, e.g.\nSummarize this PDF\nDraft a reply"}
								value={examplePromptsText}
							/>
							<p className="text-muted-foreground text-xs">
								Optional. One prompt per line.
							</p>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label htmlFor="publish-icon">Icon URL</Label>
							<Input
								id="publish-icon"
								onChange={(e) => setIconUrl(e.target.value)}
								placeholder="https://…/icon.png"
								value={iconUrl}
							/>
							<p className="text-muted-foreground text-xs">
								Optional. Must be an https link.
							</p>
						</div>

						<div className="flex flex-col gap-1.5">
							<Label htmlFor="publish-screenshots">Screenshot URLs</Label>
							<Textarea
								className="min-h-16"
								id="publish-screenshots"
								onChange={(e) => setScreenshotsText(e.target.value)}
								placeholder={"Optional. One https link per line."}
								value={screenshotsText}
							/>
						</div>

						{error ? (
							<p className="text-destructive text-sm">{error}</p>
						) : null}

						<DialogFooter>
							<Button onClick={close} variant="ghost">
								Cancel
							</Button>
							<Button
								disabled={submitting || !signedIn}
								onClick={() => handleSubmit()}
							>
								{submitting ? (
									<>
										<Spinner className="size-4" />
										Publishing…
									</>
								) : (
									"Submit for review"
								)}
							</Button>
						</DialogFooter>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
