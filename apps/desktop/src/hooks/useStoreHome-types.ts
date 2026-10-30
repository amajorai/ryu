import type { NormalizedRecommendations } from "@ryu/marketplace/catalog/recommendations";
import type { CardDither } from "@ryu/marketplace/catalog/types";
import type { ModelFormat } from "@/src/lib/api/models.ts";
import type { StoreSearchRealm } from "./useStoreSearch.ts";

/** One normalized card in a home row, realm-agnostic so rows render uniformly. */
export interface HomeCard {
	/** Ships with Ryu, apps/plugins only: its add is a local lifecycle write
	 *  rather than a catalog fetch, and Core has two endpoints for that. */
	builtIn: boolean;
	description: string | null;
	/** The listing's dithered icon wash (`icon_dither`), when it declares one.
	 *  Carried so a Home card paints the SAME tile as the card in the realm's own
	 *  tab — without it every Home row fell back to the generative placeholder and
	 *  Home, the first tab anyone sees, was the one place the icons were wrong. */
	dither: CardDither | null;
	/** ACP registry id and engine — AGENTS ROW ONLY, and null everywhere else.
	 *
	 *  They exist so Home can render the same themed brand mark the Agents cards
	 *  use (`AgentCatalogLogo`). Home used to hand the agent's raw CDN `iconUrl`
	 *  straight to the icon square, and those marks are solid black SVGs: Claude
	 *  and Codex rendered black-on-black on a dark theme. The Agents tab never had
	 *  the bug because it goes through the logo component, which pairs a
	 *  light/dark asset for the branded engines and `dark:invert`s the rest. */
	engine?: string | null;
	/** Icon-primitive glyph id (`icon`), painted inside the tile. */
	iconId: string | null;
	/** Resolvable logo URL, or null to fall back to the item's initial. */
	iconUrl: string | null;
	id: string;
	/** Already on this node — the row shows an "Added" pill instead of a button. */
	installed: boolean;
	/** The listing is covered by the A Major Pass eligibility pool. */
	membershipIncluded?: boolean;
	/** Weight format, models only: their add endpoint needs it to pick a file. */
	modelFormat: ModelFormat | null;
	name: string;
	registryId?: string | null;
	/** Short kind/format/engine chip. */
	tag: string | null;
}

/** A realm's row: a header (that opens the realm's tab), its teaser cards, and
 *  the realm's own one-call add. The add lives on the ROW, not on the card,
 *  because it is a property of the realm — five realms, five endpoints — and
 *  hanging it off each card would be five hundred identical closures. */
export interface HomeRow {
	/** Add one card from this row. Rejects with the realm client's own error. */
	add: (card: HomeCard) => Promise<void>;
	items: HomeCard[];
	realm: StoreSearchRealm;
}

export interface UseStoreHomeResult {
	forYou: StoreForYou;
	/** True while at least one realm row is still loading its first page. */
	loading: boolean;
	/** The per-realm browse rows, in display order (empty rows omitted). */
	rows: HomeRow[];
}

export interface StoreForYou {
	data: NormalizedRecommendations;
	loading: boolean;
	onCadenceChange: (cadence: NormalizedRecommendations["cadence"]) => void;
	onHide: () => void;
	onReenable: () => void;
	onRefresh: () => void;
}
