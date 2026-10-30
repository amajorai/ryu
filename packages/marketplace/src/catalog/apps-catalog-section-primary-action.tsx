import { Download01Icon, Link01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { StatusBadge } from "@ryu/ui/components/status-badge.tsx";
import type { PublisherTrustLevel } from "@ryuhq/protocol/publisher-trust";
import { type ReactNode, useState } from "react";
import {
	appPublisherHealth,
	isMandatoryListing,
} from "./apps-catalog-section-card.tsx";
import { GrantList } from "./apps-catalog-section-secondary-actions.tsx";
import { PublisherInstallDisclosure } from "./chrome/store-item-action.tsx";
import { ChannelPicker, useListingChannels } from "./detail/channel-picker.tsx";
import {
	type CatalogHost,
	type CatalogInstall,
	useCatalogHost,
} from "./host.tsx";
import ImportToolsAction from "./import-tools-action.tsx";
import { safeHttpUrl } from "./safe-url.ts";
import type { AppCatalogItem, CatalogModelProvider } from "./types.ts";

/** The Add / Enable / Disable button — the ONE control the preview dialog exists
 *  for, and therefore the one that rides in the hero, right-aligned on the title's
 *  row (see {@link ListingHero.actions}).
 *
 *  It used to sit on a solid band below the hero, on the reasoning that "a button
 *  on a saturated dither either loses its own surface colour or has to fake one".
 *  That is true of a GHOST button and false of a filled one — but the old
 *  reasoning was still half right, and honouring it is what the move actually
 *  costs: every branch below had to be re-surfaced. The Add button was `ghost`
 *  (no fill), the two link/Disable buttons were `outline` (border only), and two
 *  branches were bare `text-muted-foreground` prose. All four dissolve into an
 *  author-supplied wash. They are `secondary` + the shared hero-CTA appearance, or a
 *  hero-toned `StatusBadge`, so each keeps a surface the scrim cannot eat.
 *
 *  Split from {@link AppSecondaryActions} along STATE, not along layout: this half
 *  owns the install-time train choice and the enable-grant confirmation, which are
 *  driven by these buttons; the other half owns the post-install train switch and
 *  its confirmation. The two are mutually exclusive (`installed`), so only one of
 *  them ever resolves the channel list and there is still exactly one fetch.
 *
 *  Enable is gated behind a grant-confirmation dialog because enable is where the
 *  Gateway validates (and may deny) the app's declared grants. On a read-only
 *  surface (installLayer === null) this renders the host's affordance (Open in Ryu)
 *  instead of the lifecycle buttons. */
/** Every hero CTA gets an opaque surface of its own.
 *
 *  The hero wash is an author-supplied dither under a black scrim: a `ghost`
 *  button has no fill at all and an `outline` one has only a border, so both
 *  dissolve into whatever colour the listing happens to declare. `secondary`
 *  gives a real plate, and the ring lifts it off a busy wash without inventing a
 *  second button style. */

export function AppPrimaryAction({
	item,
	install,
	installing,
	installTaskId,
	setEnabled,
	lifecyclePending,
	installLayer,
	renderAffordance,
	modelProviders,
	publisherTrust,
}: {
	item: AppCatalogItem;
	install: (
		id?: string,
		options?: { channel?: string | null }
	) => Promise<void>;
	installing: boolean;
	/** Download-center task id this listing's add reports progress on, so the
	 *  button fills from the real transfer instead of guessing by label. */
	installTaskId: string;
	setEnabled: (enabled: boolean) => Promise<void>;
	lifecyclePending: boolean;
	installLayer: CatalogInstall | null;
	renderAffordance: CatalogHost["renderAffordance"];
	/** Provider-backed sidecars need a stronger disclosure than a raw grant list. */
	modelProviders?: CatalogModelProvider[] | null;
	/** Resolved publisher identity mark (detail record over card). A dotted
	 *  publisher gets the same two-step install disclosure as the cards. */
	publisherTrust?: PublisherTrustLevel | null;
}) {
	const tl = useLiteralMessages();
	const host = useCatalogHost();
	const node = host.useActiveNode();
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [disclosureOpen, setDisclosureOpen] = useState(false);
	const { entry, grants, installed, enabled } = item;
	const providers = modelProviders ?? [];

	// Which train to ADD. Resolved only before install — the post-install "which
	// train do I follow" question belongs to AppSecondaryActions, and the two are
	// mutually exclusive, so between them the list is fetched once.
	const { channels } = useListingChannels(
		entry.id,
		entry.repo_url,
		installed ? undefined : host.fetchListingChannels
	);
	const [channel, setChannel] = useState<string | null>(null);

	// Rejections are captured into the hook's `error` state (rendered by
	// AppSecondaryActions), so these fire-and-forget handlers swallow them to
	// avoid a floating promise.
	const noop = () => {
		// intentionally empty: error is surfaced via the hook
	};
	const runDisable = () => {
		setEnabled(false).catch(noop);
	};
	const startInstall = () => {
		install(entry.id, channel ? { channel } : undefined).catch(noop);
	};
	// The hero's Get must not be a one-click way around the cards' unverified-
	// publisher disclosure: opening a card lands here.
	const needsPublisherDisclosure = !installed && publisherTrust === "dotted";
	const runInstall = () => {
		if (needsPublisherDisclosure) {
			setDisclosureOpen(true);
			return;
		}
		startInstall();
	};
	const confirmEnable = () => {
		setConfirmOpen(false);
		setEnabled(true).catch(noop);
	};

	let action: ReactNode;
	if (isMandatoryListing(entry)) {
		// Required for Core: no lifecycle buttons, and a sentence saying why rather
		// than a silently empty footer. Checked FIRST so it beats every branch below,
		// including the install/enable ones — a mandatory app is always already
		// installed and enabled, so any other branch could only offer a wrong verb.
		action = (
			// A chip, not a paragraph of muted prose: this renders on the hero's
			// dither under a black scrim, where `text-muted-foreground` is close to
			// unreadable and a sentence competes with the listing's own name.
			<StatusBadge
				kind="builtin"
				label="Part of Ryu — required, and cannot be disabled or removed"
				tone="hero"
			/>
		);
	} else if (entry.descriptor_only) {
		// integrations.sh ships only a docs link, never a runnable config. For an
		// MCP directory entry we can still reach a real one-click install: hand off
		// to the in-app MCP catalog (backed by the official MCP registry),
		// pre-filtered by name, which resolves + installs the server. Desktop only
		// (an install layer + a navigate seam present); web keeps the docs link.
		if (entry.integration_kind === "mcp" && installLayer && host.navigate) {
			const openMcpCatalog = () =>
				host.navigate?.(`/store/mcp/q/${encodeURIComponent(entry.name)}`);
			action = (
				<Button onClick={openMcpCatalog} size="sm">
					<HugeiconsIcon className="size-4" icon={Download01Icon} />
					Find in MCP catalog
				</Button>
			);
		} else if (entry.integration_kind === "openapi" && installLayer) {
			// A REST API directory entry: import its OpenAPI spec as gateway-governed
			// `http` tools (resolved server-side via apis.guru from the entry id).
			action = (
				<ImportToolsAction
					body={{ id: entry.id }}
					endpoint="/api/tools/import/openapi"
					node={node}
				/>
			);
		} else if (
			entry.integration_kind === "graphql" &&
			installLayer &&
			entry.integration_url
		) {
			// A GraphQL endpoint: import it as a single gateway-governed query tool.
			action = (
				<ImportToolsAction
					body={{ name: entry.name, url: entry.integration_url }}
					endpoint="/api/tools/import/graphql"
					node={node}
				/>
			);
		} else {
			const href = safeHttpUrl(entry.integration_url);
			action = href ? (
				<Button
					appearance="marketplace-hero-cta"
					render={<a href={href} rel="noopener noreferrer" target="_blank" />}
					size="sm"
					variant="secondary"
				>
					<HugeiconsIcon className="size-4" icon={Link01Icon} />
					View setup docs
				</Button>
			) : (
				<StatusBadge
					kind="unavailable"
					label="Browse-only descriptor — no install URL on file"
					tone="hero"
				/>
			);
		}
	} else if (!installLayer) {
		// Read-only surface: no local install; deep-link into the Ryu app instead.
		action =
			renderAffordance?.({
				id: entry.id,
				name: entry.name,
				realm: "app",
			}) ?? null;
	} else if (!installed) {
		const InstallButton = installLayer.InstallButton;
		action = (
			<>
				<ChannelPicker
					channels={channels}
					onChange={setChannel}
					value={channel}
				/>
				<InstallButton
					busyLabel="Installing…"
					idleVariant="outline"
					installing={installing}
					onClick={runInstall}
					// The exact task id, not just the display name: Core labels a plugin
					// download row with the plugin ID, so a name hint never matched and the
					// button showed whichever single download happened to be running.
					progress={{
						kinds: ["tool", "other"],
						name: entry.id,
						taskId: installTaskId,
					}}
				>
					<HugeiconsIcon className="size-4" icon={Download01Icon} />
					Get
				</InstallButton>
			</>
		);
	} else if (enabled) {
		action = (
			<Button
				appearance="marketplace-hero-cta"
				loading={lifecyclePending}
				onClick={runDisable}
				size="sm"
				variant="secondary"
			>
				Disable
			</Button>
		);
	} else {
		action = (
			<Button
				loading={lifecyclePending}
				onClick={() => setConfirmOpen(true)}
				size="sm"
			>
				Enable
			</Button>
		);
	}

	return (
		<>
			{action}
			{installLayer && needsPublisherDisclosure ? (
				<PublisherInstallDisclosure
					onInstall={startInstall}
					onOpenChange={setDisclosureOpen}
					open={disclosureOpen}
					publisherHealth={appPublisherHealth(entry)}
					publisherTrust="dotted"
				/>
			) : null}
			{/* Enable confirmation: list grants before enabling. Install-only.
			    Rendered from here because `confirmOpen` is this component's state and
			    the button that sets it is right above; the dialog itself portals out,
			    so living inside the hero costs it nothing. */}
			{installLayer ? (
				<AlertDialog onOpenChange={setConfirmOpen} open={confirmOpen}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>
								{tl("Enable {name}?", { name: entry.name })}
							</AlertDialogTitle>
							<AlertDialogDescription>
								{grants.length === 0
									? "This plugin requests no special permissions."
									: "Enabling grants this plugin the following permissions. They are validated by the Gateway."}
							</AlertDialogDescription>
						</AlertDialogHeader>
						{providers.length > 0 ? (
							<AuthBridgeConsent providers={providers} />
						) : null}
						{grants.length > 0 && <GrantList grants={grants} />}
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction onClick={confirmEnable}>
								Allow
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			) : null}
		</>
	);
}

/** Consent copy for a provider-backed sidecar. A grant list alone says nothing
 * about credential custody or request visibility, which is the material risk of
 * an auth bridge. */
export function AuthBridgeConsent({
	providers,
}: {
	providers: CatalogModelProvider[];
}) {
	return (
		<div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
			<p className="font-medium">Handles provider credentials and traffic</p>
			<p className="mt-1 text-muted-foreground text-xs leading-relaxed">
				This plugin runs a local process that can handle the listed provider
				login credentials and read requests and responses routed through it.
				Enable it only if you trust the publisher.
			</p>
			<ul className="mt-2 flex flex-col gap-1 text-xs">
				{providers.map((provider) => (
					<li key={provider.id}>
						{provider.label?.trim() || provider.id}
						{provider.models?.length ? ` (${provider.models.join(", ")})` : ""}
					</li>
				))}
			</ul>
		</div>
	);
}
