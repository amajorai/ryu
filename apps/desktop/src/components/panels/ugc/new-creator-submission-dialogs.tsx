import { UserGroupIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useCallback, useMemo, useState } from "react";
import type {
	CampaignView as Campaign,
	CreatorView as Creator,
	PlatformView as PlatformSource,
} from "../ugc-wire-contracts.ts";
import { describeError, useUgcCall } from "./ugc-format.ts";
import { ErrorBanner } from "./ugc-primitives.tsx";

/** Add someone to the roster. `display_name` is the sidecar's only required
 *  field; `handles` is a per-platform map, so it is collected as one row per
 *  curated platform rather than as free text a refresh could never match. */
export function NewCreatorDialog({
	onCreated,
	onOpenChange,
	open,
}: {
	onCreated: () => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
}) {
	const call = useUgcCall();
	const [displayName, setDisplayName] = useState("");
	const [contactEmail, setContactEmail] = useState("");
	const [payoutHandle, setPayoutHandle] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const submit = useCallback(async () => {
		setError(null);
		setSaving(true);
		try {
			await call("/creators", {
				body: JSON.stringify({
					contact_email: contactEmail.trim() || null,
					display_name: displayName.trim(),
					payout_handle: payoutHandle.trim() || null,
				}),
				method: "POST",
			});
			onCreated();
			onOpenChange(false);
			setDisplayName("");
			setContactEmail("");
			setPayoutHandle("");
		} catch (err) {
			setError(describeError(err));
		} finally {
			setSaving(false);
		}
	}, [call, contactEmail, displayName, onCreated, onOpenChange, payoutHandle]);

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Add a creator</DialogTitle>
					<DialogDescription>
						The roster is shared across campaigns. Payout details are recorded
						here only — this app tracks what is owed, it does not move money.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="ugc-creator-name">Display name</Label>
						<Input
							id="ugc-creator-name"
							onChange={(e) => setDisplayName(e.target.value)}
							placeholder="Ada Lovelace"
							value={displayName}
						/>
					</div>
					<div className="grid grid-cols-2 gap-2">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="ugc-creator-email">Contact email</Label>
							<Input
								autoComplete="off"
								id="ugc-creator-email"
								onChange={(e) => setContactEmail(e.target.value)}
								placeholder="ada@example.com"
								type="email"
								value={contactEmail}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="ugc-creator-payout">Payout handle</Label>
							<Input
								id="ugc-creator-payout"
								onChange={(e) => setPayoutHandle(e.target.value)}
								placeholder="PayPal, bank alias…"
								value={payoutHandle}
							/>
						</div>
					</div>
					{error ? <ErrorBanner message={error} /> : null}
				</div>
				<DialogFooter>
					<Button
						onClick={() => onOpenChange(false)}
						type="button"
						variant="ghost"
					>
						Cancel
					</Button>
					<Button
						disabled={displayName.trim().length === 0}
						loading={saving}
						onClick={() => {
							submit().catch(() => undefined);
						}}
						type="button"
					>
						Add creator
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function NewSubmissionDialog({
	campaign,
	creators,
	onCreated,
	onOpenChange,
	open,
	platforms,
}: {
	campaign: Campaign;
	creators: Creator[];
	onCreated: () => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	platforms: PlatformSource[];
}) {
	const tl = useLiteralMessages();
	const call = useUgcCall();
	const [creatorId, setCreatorId] = useState("");
	const [platform, setPlatform] = useState("");
	const [postUrl, setPostUrl] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	// A campaign that names its own platforms constrains the picker; otherwise
	// every curated platform is offered.
	const options = useMemo(() => {
		const declared = campaign.platforms ?? [];
		if (declared.length === 0) {
			return platforms;
		}
		return platforms.filter((p) => declared.includes(p.platform));
	}, [campaign.platforms, platforms]);

	const submit = useCallback(async () => {
		setError(null);
		setSaving(true);
		try {
			await call("/submissions", {
				body: JSON.stringify({
					campaign_id: campaign.id,
					creator_id: creatorId,
					platform,
					post_url: postUrl.trim(),
				}),
				method: "POST",
			});
			onCreated();
			onOpenChange(false);
			setPostUrl("");
		} catch (err) {
			// A duplicate post in this campaign comes back as a 409 with the
			// sidecar's own wording — show it, never swallow it into a success.
			setError(describeError(err));
		} finally {
			setSaving(false);
		}
	}, [
		call,
		campaign.id,
		creatorId,
		onCreated,
		onOpenChange,
		platform,
		postUrl,
	]);

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Record a submission</DialogTitle>
					<DialogDescription>
						{tl(
							"{campaign} — the post URL is parsed for the platform id that metric refreshes look up.",
							{ campaign: campaign.brand || tl("This campaign") }
						)}
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="ugc-submission-creator">Creator</Label>
						{creators.length === 0 ? (
							<p className="flex items-center gap-1.5 text-muted-foreground text-xs">
								<HugeiconsIcon className="size-3.5" icon={UserGroupIcon} />
								No creators on the roster yet.
							</p>
						) : (
							<NativeSelect
								className="w-full"
								id="ugc-submission-creator"
								onChange={(e) => setCreatorId(e.target.value)}
								value={creatorId}
							>
								<NativeSelectOption value="">
									Select a creator…
								</NativeSelectOption>
								{creators.map((c) => (
									<NativeSelectOption key={c.id} value={c.id}>
										{c.display_name}
									</NativeSelectOption>
								))}
							</NativeSelect>
						)}
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="ugc-submission-platform">Platform</Label>
						<NativeSelect
							className="w-full"
							id="ugc-submission-platform"
							onChange={(e) => setPlatform(e.target.value)}
							value={platform}
						>
							<NativeSelectOption value="">
								Select a platform…
							</NativeSelectOption>
							{options.map((p) => (
								<NativeSelectOption key={p.platform} value={p.platform}>
									{p.label}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="ugc-submission-url">Post URL</Label>
						<Input
							id="ugc-submission-url"
							onChange={(e) => setPostUrl(e.target.value)}
							placeholder="https://www.tiktok.com/@creator/video/7301…"
							spellCheck={false}
							value={postUrl}
						/>
					</div>
					{error ? <ErrorBanner message={error} /> : null}
				</div>
				<DialogFooter>
					<Button
						onClick={() => onOpenChange(false)}
						type="button"
						variant="ghost"
					>
						Cancel
					</Button>
					<Button
						disabled={
							creatorId.length === 0 ||
							platform.length === 0 ||
							postUrl.trim().length === 0
						}
						loading={saving}
						onClick={() => {
							submit().catch(() => undefined);
						}}
						type="button"
					>
						Record submission
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
