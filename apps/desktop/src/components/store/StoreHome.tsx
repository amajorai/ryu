import { InstallProgressButton } from "@ryu/blocks/desktop/install-button.tsx";
import MarketplaceHome, {
	type MarketplaceHomeItem,
	type MarketplaceHomeShelf,
} from "@ryu/marketplace/catalog/chrome/marketplace-home";
import { MARKETPLACE_HOME_SHELVES } from "@ryu/marketplace/catalog/chrome/marketplace-sections";
import { storeItemContextMenu } from "@ryu/marketplace/catalog/chrome/store-item-action";
import type { RecommendationItem } from "@ryu/marketplace/catalog/recommendations";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	type HomeCard,
	type HomeRow,
	useStoreHome,
} from "@/src/hooks/useStoreHome.ts";
import type { StoreSearchRealm } from "@/src/hooks/useStoreSearch.ts";
import { AgentCatalogLogo } from "@/src/lib/agent-catalog-logo.tsx";
import { useInstallingLookup } from "@/src/store/useInstallStore.ts";

function initialGlyph(name: string) {
	return (
		<span className="font-medium text-muted-foreground text-sm uppercase">
			{name.trim().charAt(0) || "?"}
		</span>
	);
}

export default function StoreHome({
	onOpenRealm,
}: {
	onOpenRealm: (
		realm: StoreSearchRealm,
		query: string,
		itemId?: string
	) => void;
}) {
	const { forYou, rows, loading } = useStoreHome();
	const isInstalling = useInstallingLookup();

	const rowsByRealm = new Map(rows.map((row) => [row.realm, row]));
	const shelves: MarketplaceHomeShelf[] = MARKETPLACE_HOME_SHELVES.map(
		(definition) => {
			const row = rowsByRealm.get(definition.key);
			return row
				? rowShelf(row, onOpenRealm, isInstalling)
				: { items: [], key: definition.key, loading };
		}
	);

	return (
		<MarketplaceHome
			hideEmptyShelves
			loading={loading}
			recommendations={{
				data: forYou.data,
				loading: forYou.loading,
				onCadenceChange: forYou.onCadenceChange,
				onHide: forYou.onHide,
				onOpen: (item) => onOpenRealm(recommendationRealm(item), "", item.id),
				onRefresh: forYou.onRefresh,
				onReenable: forYou.onReenable,
			}}
			shelves={shelves}
		/>
	);
}

function recommendationRealm(item: RecommendationItem): StoreSearchRealm {
	return item.kind === "app"
		? "apps"
		: item.kind === "plugin"
			? "plugins"
			: item.kind === "mcp"
				? "mcp"
				: item.kind === "skill"
					? "skills"
					: item.kind === "agent"
						? "agents"
						: "models";
}

function rowShelf(
	row: HomeRow,
	onOpenRealm: (
		realm: StoreSearchRealm,
		query: string,
		itemId?: string
	) => void,
	isInstalling: (id: string) => boolean
): MarketplaceHomeShelf {
	return {
		items: row.items.map((item) =>
			rowItem(row, item, onOpenRealm, isInstalling)
		),
		key: row.realm,
		onSeeAll: () => onOpenRealm(row.realm, ""),
	};
}

function rowItem(
	row: HomeRow,
	item: HomeCard,
	onOpenRealm: (
		realm: StoreSearchRealm,
		query: string,
		itemId?: string
	) => void,
	isInstalling: (id: string) => boolean
): MarketplaceHomeItem {
	return {
		action: (
			<HomeCardAction
				busy={isInstalling(item.id)}
				installed={item.installed}
				onAdd={() => {
					row.add(item).catch(() => {
						// The realm owns error presentation; release the button so a
						// failed add can be retried from Home.
					});
				}}
			/>
		),
		brandIcon:
			row.realm === "agents" ? (
				<AgentCatalogLogo
					entry={{
						engine: item.engine ?? null,
						id: item.id,
						name: item.name,
						registryId: item.registryId ?? null,
					}}
					size="40px"
				/>
			) : undefined,
		contextMenu: storeItemContextMenu({
			installed: item.installed,
			onInstall: () => {
				row.add(item).catch(() => {
					// The realm owns error presentation.
				});
			},
		}),
		description: item.description,
		dither: item.dither,
		icon: initialGlyph(item.name),
		iconId: item.iconId,
		iconUrl: item.iconUrl,
		id: item.id,
		likeNamespace: item.id,
		membershipIncluded: item.membershipIncluded,
		name: item.name,
		onClick: () => onOpenRealm(row.realm, "", item.id),
		seedId: item.id,
	};
}

function HomeCardAction({
	busy,
	installed,
	onAdd,
}: {
	busy: boolean;
	installed: boolean;
	onAdd: () => void;
}) {
	if (installed) {
		return (
			<Button
				className="shrink-0 text-muted-foreground"
				disabled
				size="sm"
				variant="ghost"
			>
				Added
			</Button>
		);
	}

	return (
		<InstallProgressButton
			className="shrink-0"
			idleVariant="outline"
			installing={busy}
			onClick={onAdd}
		>
			Add
		</InstallProgressButton>
	);
}
