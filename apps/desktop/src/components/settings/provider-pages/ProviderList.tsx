// The one list of the provider settings: the default provider, the connected
// providers under a search field, the providers that are not connected, and
// the rows that open the pages every provider shares (account pools, agent
// models, model parameters, media providers) or jump to a neighbouring pane.
// Every row has the same shape and opens exactly one page.

import {
	GitBranchIcon,
	Image01Icon,
	Key01Icon,
	PlusSignIcon,
	Robot01Icon,
	Share08Icon,
	SlidersHorizontalIcon,
	SquareLock01Icon,
	UserGroupIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { SettingsIconTile } from "@ryu/blocks/desktop/settings-nav.tsx";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { StatusBadge } from "@ryu/ui/components/status-badge.tsx";
import type { ReactNode } from "react";
import type { PiConfig, PiProvider } from "@/src/lib/api/pi-config.ts";
import { ProviderBrandMark } from "../LlmProvidersSettings-model-picker.tsx";
import { managedBadgeLabel } from "../LlmProvidersSettings-shared.ts";
import { SettingsGroup, SettingsSection } from "../shared/settings-items.tsx";
import { ProviderNavRow } from "./ProviderPageFrame.tsx";
import {
	type ExtraPageId,
	groupProviders,
	LINKED_SECTIONS,
	type LinkedSection,
	type ManagedFunding,
	matchesQuery,
	type ProviderKind,
	type ProviderPageId,
	type ProviderSummary,
	providerKind,
	providerPageId,
	providerRowStatus,
	providerSummary,
} from "./provider-pages-model.ts";

/** The small label that tells the kinds of provider apart on a row. */
export const KIND_LABELS: Record<ProviderKind, string> = {
	"api-key": "API key",
	custom: "Custom",
	local: "Local",
	managed: "Ryu managed",
	subscription: "Subscription",
};

/** The summary descriptor of a row as one line of text. */
export function summaryText(
	summary: ProviderSummary,
	tl: LiteralMessage
): string {
	switch (summary.id) {
		case "managed":
			return tl(managedBadgeLabel(summary.needsCredits, summary.poolBacked));
		case "not-connected":
			return tl("Not connected");
		case "accounts":
			return tl("Accounts: {count}", { count: summary.count });
		case "account":
			return summary.label;
		case "connected":
			return tl("Connected");
		case "ready":
			return tl("Ready");
		default:
			return tl("Configured");
	}
}

/** Kind and summary of one provider, as the row's one quiet line. */
export function providerRowLine(
	provider: PiProvider,
	funding: ManagedFunding,
	tl: LiteralMessage
): string {
	const kind = providerKind(provider);
	const summary = summaryText(providerSummary(provider, funding), tl);
	// A managed row's summary already says "Ryu managed" or what it needs.
	return kind === "managed" ? summary : `${tl(KIND_LABELS[kind])} · ${summary}`;
}

interface ExtraRow {
	icon: IconSvgElement;
	/** Extra words a search may match, in English. */
	keywords: string;
	title: string;
}

/** The pages every provider shares, in list order. */
export const EXTRA_ROWS: Record<ExtraPageId, ExtraRow> = {
	"account-pools": {
		icon: UserGroupIcon,
		keywords: "pool pools rotate rotation accounts agents backup",
		title: "Account pools",
	},
	"agent-models": {
		icon: Robot01Icon,
		keywords: "agent bot models visibility picker hide",
		title: "Agent models",
	},
	"model-parameters": {
		icon: SlidersHorizontalIcon,
		keywords: "temperature presets parameters tune generation",
		title: "Model parameters",
	},
	"custom-provider": {
		icon: PlusSignIcon,
		keywords: "custom openai compatible endpoint local ollama base url add",
		title: "Custom OpenAI-compatible provider",
	},
	capabilities: {
		icon: Image01Icon,
		keywords: "image speech video embeddings media replicate fal voice",
		title: "Image, speech, video, and embeddings",
	},
	"gateway-keys": {
		icon: SquareLock01Icon,
		keywords: "gateway keys app access auth manage web console",
		title: "Gateway keys",
	},
};

/** The rows that open a neighbouring pane of the same window. */
export const LINK_ROWS: Record<LinkedSection, ExtraRow> = {
	keys: {
		icon: Key01Icon,
		keywords: "keys byok credentials tokens gateway sdk speech web accounts",
		title: "API keys",
	},
	integrations: {
		icon: Share08Icon,
		keywords: "integrations composio apps oauth connect",
		title: "Integrations",
	},
	routing: {
		icon: GitBranchIcon,
		keywords: "routing fallback smart route egress retry defaults",
		title: "Model routing",
	},
};

const MORE_PAGES = [
	"account-pools",
	"agent-models",
	"model-parameters",
	"capabilities",
	"gateway-keys",
] as const satisfies readonly ExtraPageId[];

function rowMatches(row: ExtraRow, query: string, tl: LiteralMessage): boolean {
	return matchesQuery(`${row.title}\n${tl(row.title)}\n${row.keywords}`, query);
}

/** The status at the end of a provider row: one short word, or nothing. */
export function ProviderRowEnd({ provider }: { provider: PiProvider }) {
	const status = providerRowStatus(provider);
	if (status === "needs-sign-in") {
		return (
			<Badge tint="amber" variant="outline">
				Needs sign-in
			</Badge>
		);
	}
	return status === "active" ? <StatusBadge kind="active" /> : null;
}

interface ProviderListProps {
	activeConfig: PiConfig | null;
	funding: ManagedFunding;
	/** Whether the host gave a gateway keys page. Without one the row is left out. */
	gatewayKeys: boolean;
	/** A billing note above the list. */
	intro?: ReactNode;
	onOpen: (page: ProviderPageId, rowId: string) => void;
	/** Jump to another pane of the window. Absent outside the settings window. */
	onOpenSection?: (section: LinkedSection) => void;
	onQueryChange: (query: string) => void;
	/** The number of account pools, or null while it is not known yet. */
	poolCount: number | null;
	/** False on a node whose Core has no account pools: the row is left out. */
	poolsSupported: boolean;
	providers: PiProvider[];
	query: string;
}

export function ProviderList({
	activeConfig,
	funding,
	gatewayKeys,
	intro,
	onOpen,
	onOpenSection,
	onQueryChange,
	poolCount,
	poolsSupported,
	providers,
	query,
}: ProviderListProps) {
	const tl = useLiteralMessages();
	const groups = groupProviders(providers, query);
	const searching = query.trim() !== "";
	const defaultProvider =
		providers.find((provider) => provider.active) ??
		providers.find((provider) => provider.id === activeConfig?.provider) ??
		null;
	const morePages = MORE_PAGES.filter(
		(id) =>
			(id !== "account-pools" || poolsSupported) &&
			(id !== "gateway-keys" || gatewayKeys) &&
			rowMatches(EXTRA_ROWS[id], query, tl)
	);
	const links = onOpenSection
		? LINKED_SECTIONS.filter((section) =>
				rowMatches(LINK_ROWS[section], query, tl)
			)
		: [];
	const customShown = rowMatches(EXTRA_ROWS["custom-provider"], query, tl);
	const nothing =
		searching &&
		groups.connected.length === 0 &&
		groups.other.length === 0 &&
		morePages.length === 0 &&
		links.length === 0 &&
		!customShown;

	const providerRow = (provider: PiProvider) => (
		<ProviderNavRow
			end={<ProviderRowEnd provider={provider} />}
			key={provider.id}
			// The mark resolves on id and label only, never on the api type: every
			// OpenAI-compatible provider's api contains "openai".
			mark={
				<ProviderBrandMark
					label={provider.label}
					providerKey={`${provider.id} ${provider.label}`}
				/>
			}
			onOpen={() =>
				onOpen(providerPageId(provider.id), providerPageId(provider.id))
			}
			rowId={providerPageId(provider.id)}
			summary={providerRowLine(provider, funding, tl)}
			title={<span data-slot="provider-label">{provider.label}</span>}
		/>
	);
	const extraRow = (id: ExtraPageId, end?: ReactNode) => (
		<ProviderNavRow
			end={end}
			key={id}
			mark={<SettingsIconTile icon={EXTRA_ROWS[id].icon} />}
			onOpen={() => onOpen(id, id)}
			rowId={id}
			title={tl(EXTRA_ROWS[id].title)}
		/>
	);
	const search = (
		<Input
			aria-label={tl("Search providers and models…")}
			className="h-8 w-56 max-w-full"
			onChange={(event) => onQueryChange(event.target.value)}
			placeholder={tl("Search providers and models…")}
			type="search"
			value={query}
		/>
	);

	return (
		<div className="flex flex-col gap-6" data-provider-list="">
			{intro}
			{defaultProvider && !searching ? (
				<SettingsSection>
					<SettingsGroup>
						<ProviderNavRow
							end={
								<span className="max-w-40 truncate text-muted-foreground text-sm">
									{defaultProvider.label}
								</span>
							}
							onOpen={() =>
								onOpen(providerPageId(defaultProvider.id), "default")
							}
							rowId="default"
							summary={activeConfig?.model || undefined}
							title={tl("Default provider")}
						/>
					</SettingsGroup>
				</SettingsSection>
			) : null}

			<SettingsSection className="mt-0" headerAction={search} title="Connected">
				{groups.connected.length > 0 ? (
					<SettingsGroup>{groups.connected.map(providerRow)}</SettingsGroup>
				) : null}
				{/* One calm line instead of an empty card. While a search runs it
				    shows only when no row of the whole list matches. */}
				{groups.connected.length === 0 && (nothing || !searching) ? (
					<p
						className="py-3 text-muted-foreground text-sm"
						data-provider-list-empty=""
						role="status"
					>
						{searching
							? tl("Nothing matches your search.")
							: tl("No providers connected yet.")}
					</p>
				) : null}
			</SettingsSection>

			{groups.other.length > 0 || customShown ? (
				<SettingsSection className="mt-0" title="Other">
					<SettingsGroup>
						{groups.other.map(providerRow)}
						{customShown ? extraRow("custom-provider") : null}
					</SettingsGroup>
				</SettingsSection>
			) : null}

			{morePages.length > 0 || links.length > 0 ? (
				<SettingsSection className="mt-0" title="More">
					<SettingsGroup>
						{morePages.map((id) =>
							extraRow(
								id,
								id === "account-pools" && poolCount !== null ? (
									<span className="text-muted-foreground text-sm">
										{poolCount}
									</span>
								) : undefined
							)
						)}
						{links.map((section) => (
							<ProviderNavRow
								key={section}
								mark={<SettingsIconTile icon={LINK_ROWS[section].icon} />}
								onOpen={() => onOpenSection?.(section)}
								rowId={`section:${section}`}
								title={tl(LINK_ROWS[section].title)}
							/>
						))}
					</SettingsGroup>
				</SettingsSection>
			) : null}
		</div>
	);
}
