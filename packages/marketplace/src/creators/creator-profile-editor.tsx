// packages/marketplace/src/creators/creator-profile-editor.tsx
//
// The Sell tab's editor for the active organization's public creator profile:
// the bio and links shown on its Creators page. Renders nothing on a surface
// whose host does not provide `creators.ownProfile`. `layout="settings"` frames
// it as an iOS-style settings section (header, card, caption) instead of the
// Store page's own card.

import { UserEdit01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	SettingsCard,
	SettingsSection,
} from "@ryu/blocks/desktop/settings-items.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Field,
	FieldDescription,
	FieldGroup,
	FieldLabel,
} from "@ryu/ui/components/field.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type SyntheticEvent, useEffect, useId, useRef, useState } from "react";
import { sileo } from "sileo";
import { useMarketplaceHostOptional } from "../host.tsx";
import { creatorHandle } from "./creator-format.ts";
import type {
	MarketplaceCreatorProfileFields,
	MarketplaceOwnCreatorProfile,
} from "./creator-types.ts";

/** Mirrors the control plane's `MAX_CREATOR_BIO_LEN`. */
export const CREATOR_BIO_MAX_LENGTH = 280;

const EMPTY_FIELDS: MarketplaceCreatorProfileFields = {
	bio: null,
	githubHandle: null,
	website: null,
	xHandle: null,
};

const HEADING_ID = "creator-profile-editor-heading";

export function CreatorProfileEditor({
	layout = "page",
}: {
	/** The Store page's own card (default), or a settings section. */
	layout?: "page" | "settings";
} = {}) {
	const ownProfile = useMarketplaceHostOptional()?.creators?.ownProfile;
	const tl = useLiteralMessages();
	const [loaded, setLoaded] = useState<MarketplaceOwnCreatorProfile | null>(
		null
	);
	const [fields, setFields] =
		useState<MarketplaceCreatorProfileFields>(EMPTY_FIELDS);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [reloadVersion, setReloadVersion] = useState(0);
	const scopeVersion = useRef(0);
	const bioId = useId();
	const websiteId = useId();
	const githubId = useId();
	const xId = useId();

	useEffect(() => {
		if (!ownProfile) {
			return;
		}
		let cancelled = false;
		scopeVersion.current += 1;
		setLoaded(null);
		setLoadError(null);
		setSaveError(null);
		setSaving(false);
		ownProfile
			.load()
			.then((next) => {
				if (!cancelled) {
					setLoaded(next);
					setFields(next.profile);
					setLoadError(null);
				}
			})
			.catch((cause) => {
				if (!cancelled) {
					setLoadError(
						cause instanceof Error
							? cause.message
							: "Could not load your creator profile."
					);
				}
			});
		return () => {
			cancelled = true;
			scopeVersion.current += 1;
		};
	}, [ownProfile, reloadVersion]);

	if (!ownProfile) {
		return null;
	}

	const update =
		(key: keyof MarketplaceCreatorProfileFields) => (value: string) =>
			setFields((current) => ({ ...current, [key]: value }));

	const handleSubmit = async (event: SyntheticEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!loaded || saving) {
			return;
		}
		setSaving(true);
		const requestVersion = scopeVersion.current;
		setSaveError(null);
		try {
			// Recheck current membership and scope before sending a retained draft.
			// PUT also checks the expected organization to close the request race.
			const current = await ownProfile.load();
			if (requestVersion !== scopeVersion.current) {
				return;
			}
			if (current.organizationId !== loaded.organizationId) {
				setLoaded(null);
				setLoadError(
					"The active organization changed. Reload your creator profile before saving."
				);
				return;
			}
			const saved = await ownProfile.save(fields, loaded.organizationId);
			if (requestVersion !== scopeVersion.current) {
				return;
			}
			setFields(saved);
			sileo.success({ title: "Creator profile saved" });
		} catch (cause) {
			if (requestVersion !== scopeVersion.current) {
				return;
			}
			setSaveError(
				cause instanceof Error ? cause.message : "Could not save your profile."
			);
		} finally {
			if (requestVersion === scopeVersion.current) {
				setSaving(false);
			}
		}
	};

	const handle = loaded ? creatorHandle(loaded) : null;
	const bioLength = fields.bio?.length ?? 0;

	const description = loaded
		? handle
			? tl(
					"How {name} ({handle}) appears on the Marketplace Creators tab once it has a live public listing.",
					{ handle, name: loaded.name }
				)
			: tl(
					"How {name} appears on the Marketplace Creators tab once it has a live public listing.",
					{ name: loaded.name }
				)
		: "How your organization appears on the Marketplace Creators tab.";
	// The page card spaces its body below the header; a settings card has none.
	const bodyOffset = layout === "settings" ? undefined : "mt-4";
	const body = loadError ? (
		<div className={bodyOffset}>
			<p className="text-status-destructive text-xs" role="alert">
				{loadError}
			</p>
			<Button
				className="mt-3"
				onClick={() => setReloadVersion((version) => version + 1)}
				variant="outline"
			>
				Reload profile
			</Button>
		</div>
	) : loaded ? (
		<form className={bodyOffset} onSubmit={handleSubmit}>
			<FieldGroup>
				<Field>
					<FieldLabel htmlFor={bioId}>Bio</FieldLabel>
					<Textarea
						disabled={saving}
						id={bioId}
						maxLength={CREATOR_BIO_MAX_LENGTH}
						onChange={(event) => update("bio")(event.target.value)}
						placeholder="What do you build?"
						rows={3}
						value={fields.bio ?? ""}
					/>
					<FieldDescription>
						{bioLength}/{CREATOR_BIO_MAX_LENGTH}
					</FieldDescription>
				</Field>
				<Field>
					<FieldLabel htmlFor={websiteId}>Website</FieldLabel>
					<Input
						disabled={saving}
						id={websiteId}
						inputMode="url"
						onChange={(event) => update("website")(event.target.value)}
						placeholder="https://example.com"
						type="url"
						value={fields.website ?? ""}
					/>
				</Field>
				<div className="grid gap-4 sm:grid-cols-2">
					<Field>
						<FieldLabel htmlFor={githubId}>GitHub</FieldLabel>
						<Input
							autoCapitalize="none"
							disabled={saving}
							id={githubId}
							onChange={(event) => update("githubHandle")(event.target.value)}
							placeholder="username"
							value={fields.githubHandle ?? ""}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor={xId}>X</FieldLabel>
						<Input
							autoCapitalize="none"
							disabled={saving}
							id={xId}
							onChange={(event) => update("xHandle")(event.target.value)}
							placeholder="@handle"
							value={fields.xHandle ?? ""}
						/>
					</Field>
				</div>
			</FieldGroup>
			{saveError ? (
				<div className="mt-3">
					<p aria-live="polite" className="text-status-destructive text-xs">
						{saveError}
					</p>
					<Button
						className="mt-3"
						disabled={saving}
						onClick={() => setReloadVersion((version) => version + 1)}
						type="button"
						variant="outline"
					>
						Reload profile
					</Button>
					<p className="mt-2 text-muted-foreground text-xs">
						Reloading replaces your draft with the current organization's saved
						profile.
					</p>
				</div>
			) : null}
			<Button className="mt-4" loading={saving} type="submit">
				Save profile
			</Button>
		</form>
	) : (
		<div
			className={cn(
				bodyOffset,
				"flex items-center gap-2 text-muted-foreground text-sm"
			)}
		>
			<Spinner className="size-4" />
			Loading your creator profile…
		</div>
	);

	if (layout === "settings") {
		return (
			<section
				aria-labelledby={HEADING_ID}
				data-testid="creator-profile-editor"
			>
				<SettingsSection
					caption={description}
					title={<span id={HEADING_ID}>Creator profile</span>}
				>
					<SettingsCard>{body}</SettingsCard>
				</SettingsSection>
			</section>
		);
	}

	return (
		<section
			aria-labelledby={HEADING_ID}
			className="mt-5 rounded-lg bg-card p-5"
			data-testid="creator-profile-editor"
		>
			<div className="flex items-start gap-3">
				<HugeiconsIcon
					aria-hidden="true"
					className="mt-0.5 size-6 text-muted-foreground"
					icon={UserEdit01Icon}
				/>
				<div className="flex-1">
					<h3 className="font-medium text-sm" id={HEADING_ID}>
						Creator profile
					</h3>
					<p className="mt-1 text-muted-foreground text-sm">{description}</p>
				</div>
			</div>

			{body}
		</section>
	);
}
