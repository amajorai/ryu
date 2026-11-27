// The host of the provider settings: one list and, one level down, one page.
// It owns which page is open, the search text (kept while a page is open, so
// coming back shows the same list), and the focus: a page takes focus on its
// title when it opens, and "back" hands it to the row that opened the page.

import { useLiteralMessages } from "@ryu/i18n/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useEntitlementContext } from "@/src/contexts/entitlement-context.tsx";
import { usePendingSubpage } from "@/src/hooks/useSettingSubpage.ts";
import type {
	PiCatalog,
	PiConfig,
	PiProvider,
} from "@/src/lib/api/pi-config.ts";
import { AgentModelsSettings } from "../AgentModelsSettings.tsx";
import { CapabilityProvidersSettings } from "../CapabilityProvidersSettings.tsx";
import { CustomProviderForm } from "../LlmProvidersSettings-custom-provider-form.tsx";
import type { ProviderCardProps } from "../LlmProvidersSettings-shared.ts";
import { ModelParametersSettings } from "../ModelParametersSettings.tsx";
import { SettingsSection } from "../shared/settings-items.tsx";
import { AccountPoolsPage } from "./AccountPoolsPage.tsx";
import { useAccountPoolCatalog } from "./ProviderAccountPools.tsx";
import { EXTRA_ROWS, ProviderList } from "./ProviderList.tsx";
import { ProviderPage } from "./ProviderPage.tsx";
import { PAGE_ROW_ATTRIBUTE, ProviderPageFrame } from "./ProviderPageFrame.tsx";
import {
	type ExtraPageId,
	type LinkedSection,
	type ManagedFunding,
	type ProviderPageId,
	pageProviderId,
	providerPageId,
	resolvePage,
} from "./provider-pages-model.ts";

/** The settings search section these pages live in. */
export const PROVIDERS_SECTION = "providers";
/** The name of the list, which the back control of every page names. */
const LIST_TITLE = "AI providers";

/** A provider that was just added, and whether the focus waits for its row. */
interface AddedRow {
	parked: boolean;
	row: string;
}

/**
 * Pay the focus the list owes: to `row` when it is on the list, else to the
 * search field, the first control of the list. Returns true while the focus
 * stays owed, which is while a provider that was just added is not `listed`
 * in the catalog React has; the search field holds the focus until then.
 */
function payListFocus(
	list: HTMLElement | null,
	row: string | null,
	added: AddedRow | null,
	listed: boolean
): boolean {
	const search =
		list?.querySelector<HTMLElement>('input[type="search"]') ?? null;
	if (added?.parked && document.activeElement !== (search ?? document.body)) {
		// The user moved the focus while the row was on its way: it is theirs.
		return false;
	}
	const target = row
		? (list?.querySelector<HTMLElement>(
				`[${PAGE_ROW_ATTRIBUTE}="${CSS.escape(row)}"]`
			) ?? null)
		: null;
	(target ?? search)?.focus();
	return added !== null && target === null && !listed;
}

export interface ProviderPagesProps {
	activeConfig: PiConfig | null;
	agentModelOverrides: PiCatalog["agentModelOverrides"];
	apiTypes: string[];
	/** What every provider page needs besides its provider. */
	cardProps: Omit<ProviderCardProps, "activeConfig" | "provider">;
	/** The gateway's own keys, read only. Absent outside the settings window. */
	gatewayKeys?: ReactNode;
	/** A note above the list, such as who pays for managed models. */
	intro?: ReactNode;
	onCreateCustom: (input: {
		api: string;
		apiKey: string | null;
		baseUrl: string;
		provider: string;
	}) => Promise<void>;
	/** Jump to another pane of the settings window, when hosted in one. */
	onOpenSection?: (section: LinkedSection) => void;
	/** The catalog, already in list order. */
	providers: PiProvider[];
}

export function ProviderPages({
	activeConfig,
	agentModelOverrides,
	apiTypes,
	cardProps,
	gatewayKeys,
	intro,
	onCreateCustom,
	onOpenSection,
	providers,
}: ProviderPagesProps) {
	const tl = useLiteralMessages();
	const { verdict } = useEntitlementContext();
	const funding: ManagedFunding = {
		hasPrepaidBalance: cardProps.hasPrepaidManagedBalance,
		managedInference: verdict?.managedInference ?? false,
	};
	const pools = useAccountPoolCatalog();
	const [query, setQuery] = useState("");
	const [pageId, setPageId] = useState<string | null>(null);
	// The row that opened the page, and whether focus is owed to it.
	const lastRow = useRef<string | null>(null);
	const focusOwed = useRef(false);
	// "Add provider" resolves before the new catalog reaches React (the query
	// cache tells its observers a tick later), so the list can be on screen one
	// render ahead of the new row. The focus stays owed until the row is there.
	const added = useRef<AddedRow | null>(null);
	const container = useRef<HTMLDivElement>(null);
	// A page that names nothing (a provider that left the catalog) is the list.
	const resolved = resolvePage(pageId, providers);
	const page = resolved === "gateway-keys" && !gatewayKeys ? null : resolved;

	// A settings search result that names a page opens it.
	const revealed = usePendingSubpage(PROVIDERS_SECTION);
	useEffect(() => {
		if (revealed) {
			lastRow.current = revealed;
			setPageId(revealed);
		}
	}, [revealed]);

	// Back: once the list is on screen again, focus the row that was opened.
	// A page that was on screen and names nothing any more (its provider was
	// removed) closed itself: its row is gone too, so the search field, the
	// first control of the list, takes the focus instead of the document.
	const shown = useRef<string | null>(null);
	useEffect(() => {
		if (page !== null) {
			shown.current = pageId;
			return;
		}
		if (pageId !== null && shown.current === pageId) {
			focusOwed.current = true;
			setPageId(null);
			return;
		}
		if (!focusOwed.current) {
			return;
		}
		const row = lastRow.current;
		const fresh = added.current?.row === row ? added.current : null;
		const wait = payListFocus(
			container.current,
			row,
			fresh,
			providers.some((entry) => providerPageId(entry.id) === row)
		);
		focusOwed.current = wait;
		added.current = wait && fresh ? { parked: true, row: fresh.row } : null;
	}, [page, pageId, providers]);

	const open = (next: ProviderPageId, rowId: string) => {
		lastRow.current = rowId;
		setPageId(next);
	};
	const back = () => {
		focusOwed.current = true;
		setPageId(null);
	};
	// Typing in the search field ends the wait for a row that was just added.
	const search = (next: string) => {
		if (added.current) {
			added.current = null;
			focusOwed.current = false;
		}
		setQuery(next);
	};

	const extraPage = (id: ExtraPageId, body: ReactNode) => (
		<ProviderPageFrame
			onBack={back}
			parentTitle={LIST_TITLE}
			title={tl(EXTRA_ROWS[id].title)}
		>
			{body}
		</ProviderPageFrame>
	);

	const renderPage = (current: ProviderPageId): ReactNode => {
		const providerId = pageProviderId(current);
		if (providerId !== null) {
			const provider = providers.find((entry) => entry.id === providerId);
			return provider ? (
				<ProviderPage
					{...cardProps}
					activeConfig={activeConfig}
					funding={funding}
					// One page per provider: a new provider starts with fresh state.
					key={provider.id}
					onBack={back}
					onManagePools={() => open("account-pools", "account-pools")}
					parentTitle={LIST_TITLE}
					provider={provider}
				/>
			) : null;
		}
		switch (current) {
			case "account-pools":
				return extraPage(current, <AccountPoolsPage providers={providers} />);
			case "agent-models":
				return extraPage(
					current,
					<AgentModelsSettings
						agentModelOverrides={agentModelOverrides}
						heading={false}
						onToggleModel={cardProps.onToggleModel}
					/>
				);
			case "model-parameters":
				return extraPage(current, <ModelParametersSettings heading={false} />);
			case "custom-provider":
				return extraPage(
					current,
					<SettingsSection caption="Any OpenAI-compatible endpoint, local or hosted. It joins the provider list.">
						<CustomProviderForm
							apiTypes={apiTypes}
							onCreate={async (input) => {
								await onCreateCustom(input);
								// The new provider joined the list: show it there, focused.
								const row = providerPageId(input.provider);
								lastRow.current = row;
								added.current = { parked: false, row };
								back();
							}}
						/>
					</SettingsSection>
				);
			case "capabilities":
				return extraPage(current, <CapabilityProvidersSettings />);
			case "gateway-keys":
				return extraPage(current, gatewayKeys);
			default:
				// A provider page whose provider is gone was handled above.
				return null;
		}
	};

	return (
		<div data-provider-pages={page ?? "list"} ref={container}>
			{page === null ? (
				<ProviderList
					activeConfig={activeConfig}
					funding={funding}
					gatewayKeys={Boolean(gatewayKeys)}
					intro={intro}
					onOpen={open}
					onOpenSection={onOpenSection}
					onQueryChange={search}
					poolCount={pools.catalog?.pools.length ?? null}
					poolsSupported={pools.supported}
					providers={providers}
					query={query}
				/>
			) : (
				renderPage(page)
			)}
		</div>
	);
}
