// apps/desktop/src/components/layout/sidebar-sections.ts
//
// The sidebar's SECTION VOCABULARY — the one place the shell describes its own
// top-level sections — plus the order-persistence logic that reconciles a user's
// saved layout against it.
//
// Why this is a module and not four parallel tables inside AppSidebar.tsx: a
// section used to be spelled out five times (a closed `BuiltinSectionKey` union,
// `DEFAULT_SECTION_ORDER`, a label record, an icon record, and the tab-strip icon
// record derived from it). Five copies is how a section ends up in the order with
// no label, or labelled but never rendered. Here there is exactly ONE list —
// `BUILTIN_SECTIONS` — and the union, the default order, the labels and the icons
// are all derived from it, so adding or retiring a built-in section is a single
// entry and the compiler still proves every section has a label + a glyph.
//
// What is deliberately NOT here: apps. A Ryu App does not get an entry in this
// list — it contributes `sidebar_sections`, which the shell mints into a
// `plugin:<pluginId>:<sectionId>` {@link DynamicSectionKey} it has never heard of
// and renders generically. That is the open half of the vocabulary; this list is
// the closed half, and it is closed on purpose: these are the shell's own pages
// (Tabs, Chats, Pinned, Archived, …), they ship compiled in, and enumerating them
// is what lets `SECTION_LABELS`/`SECTION_ICONS` be exhaustive records rather than
// lookups that can miss. The rule for a reviewer: if a new section needs a Core
// app to exist, it belongs in that app's manifest, not in `BUILTIN_SECTIONS`.
//
import {
	Archive01Icon,
	Chat01Icon,
	ConnectIcon,
	DeliverySecure01Icon,
	FingerPrintIcon,
	FolderOpenIcon,
	GridIcon,
	LayerIcon,
	Package01Icon,
	PinIcon,
	PlugSocketIcon,
	PotionIcon,
	ServerStack01Icon,
	Target01Icon,
	Tv01Icon,
	UserMultiple02Icon,
	WorkflowCircle06Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

/**
 * The Core app that owns a compiled-in shell surface, keyed by a SURFACE name.
 *
 * These surfaces (Spaces, Teams, Workflows, Agents, Meetings) ship as shell
 * components but their DATA comes from an app whose routes are gated by
 * `require_app_enabled` / the ext-proxy mount. With the app off every row inside
 * them fails, so each consumer hides its entry rather than leading to a dead page.
 *
 * One table because the fact is one fact. It used to be written twice — once as
 * `SECTION_PLUGIN_OWNER` in `AppSidebar` (keyed by sidebar section) and once as
 * `SECTION_PLUGIN` in `LibraryPage` (keyed by library item type) — which is how
 * the sidebar and the Library came to disagree about who owns Agents. Consumers
 * map their own key onto a surface name here; nobody re-states the ownership.
 *
 * This is the grandfathered half. A genuinely new app-backed surface declares
 * `sidebar_sections` in its own manifest and needs no entry here at all — that is
 * what `com.ryu.{meetings,canvas,whiteboard}` do, and why their visibility follows
 * the contributions feed instead of this table.
 */
export const SURFACE_PLUGIN_OWNER = {
	agents: "@ryu/agents",
	meetings: "@ryu/meetings",
	spaces: "@ryu/spaces",
	teams: "@ryu/teams",
	workflows: "@ryu/workflows",
} as const satisfies Record<string, string>;

/** A surface name in {@link SURFACE_PLUGIN_OWNER}. */
export type OwnedSurface = keyof typeof SURFACE_PLUGIN_OWNER;

/** Every plugin id that owns a compiled-in shell surface. */
export const SURFACE_OWNER_PLUGIN_IDS: readonly string[] =
	Object.values(SURFACE_PLUGIN_OWNER);

/** localStorage key holding the user's persisted top-level section order. */
export const SECTION_ORDER_KEY = "ryu:sidebar-section-order";

/** One built-in section: its stable key, its label, and its glyph. */
interface BuiltinSectionSpec {
	icon: IconSvgElement;
	key: string;
	label: string;
}

/**
 * The built-in sections, **in default display order**. This array is the single
 * source of truth: {@link BuiltinSectionKey}, {@link DEFAULT_SECTION_ORDER},
 * {@link SECTION_LABELS} and {@link SECTION_ICONS} are all derived from it.
 *
 * All workspace projects/folders live nested under the single `projects` section.
 */
export const BUILTIN_SECTIONS = [
	{ key: "tabs", label: "Tabs", icon: GridIcon },
	{ key: "agents", label: "Agents", icon: Target01Icon },
	// Apps sits directly under Agents: an App surface is something the user opens
	// and works in, so it belongs beside the other "things I use" sections rather
	// than trailing the store-adjacent tail at the bottom.
	{ key: "companions", label: "Apps", icon: Package01Icon },
	{ key: "projects", label: "Projects", icon: FolderOpenIcon },
	{ key: "pinned", label: "Pinned", icon: PinIcon },
	{ key: "chats", label: "Chats", icon: Chat01Icon },
	{ key: "spaces", label: "Spaces", icon: DeliverySecure01Icon },
	{ key: "channels", label: "Channels", icon: Tv01Icon },
	{ key: "integrations", label: "Integrations", icon: ConnectIcon },
	{ key: "identities", label: "Identities", icon: FingerPrintIcon },
	{ key: "skills", label: "Skills", icon: PotionIcon },
	{ key: "mcp", label: "MCP", icon: ServerStack01Icon },
	{ key: "tools", label: "Tools", icon: Wrench01Icon },
	{ key: "engines", label: "Engines", icon: LayerIcon },
	{ key: "archived", label: "Archived", icon: Archive01Icon },
	// Plugins sits at the bottom of the default order — the primary "work"
	// sections come first and the store-adjacent surface trails. It is also
	// default-HIDDEN (`DEFAULT_HIDDEN_SECTIONS` in `lib/features.ts`): a position
	// here is the section's identity, not a promise that it renders.
	{ key: "plugins", label: "Plugins", icon: PlugSocketIcon },
] as const satisfies readonly BuiltinSectionSpec[];

/** The fixed, built-in sidebar sections (always present). */
export type BuiltinSectionKey = (typeof BUILTIN_SECTIONS)[number]["key"];

/** A dynamic, app-registered section key: `plugin:<pluginId>:<sectionId>`, minted
 *  from a `sidebar_sections` contribution. Namespaced so it never collides with a
 *  built-in key and is recognisable by prefix in the order/persistence machinery. */
export type DynamicSectionKey = `plugin:${string}`;

/** The reorderable top-level sidebar sections — the fixed built-ins plus any
 *  app-registered dynamic sections from the contributions feed. */
export type SectionKey = BuiltinSectionKey | DynamicSectionKey;

/** App-owned replacements for the two retired compiled section keys. Kept as a
 * migration table so every persisted preference follows the section rather than
 * silently resetting when the app starts contributing it dynamically. */
export const LEGACY_APP_SECTION_KEYS = {
	teams: "plugin:@ryu/teams:teams",
	workflows: "plugin:@ryu/workflows:workflows",
} as const satisfies Record<string, DynamicSectionKey>;

export function migrateLegacySectionKey(value: string): string {
	return (
		LEGACY_APP_SECTION_KEYS[value as keyof typeof LEGACY_APP_SECTION_KEYS] ??
		value
	);
}

/** Default top-level order, derived from {@link BUILTIN_SECTIONS}. */
export const DEFAULT_SECTION_ORDER: BuiltinSectionKey[] = BUILTIN_SECTIONS.map(
	(section) => section.key
);

/**
 * Default orders shipped by PREVIOUS versions, each deliberately a frozen
 * literal rather than something derived: they are historical snapshots that
 * {@link reconcileSectionOrder} compares a stored order against to detect "this
 * user never customised anything, they just have an older default persisted"
 * and migrate them onto the current default. Deriving them would make them track
 * the present and silently stop migrating anyone. Never edit an entry — append a
 * new snapshot if the default changes again.
 */
const LEGACY_DEFAULT_SECTION_ORDERS: string[][] = [
	// BEFORE `pinned` was promoted above `chats` (no `companions`).
	[
		"tabs",
		"agents",
		"teams",
		"projects",
		"chats",
		"spaces",
		"channels",
		"integrations",
		"plugins",
		"identities",
		"workflows",
		"skills",
		"mcp",
		"tools",
		"engines",
		"pinned",
		"archived",
	],
	// BEFORE `plugins`/`companions` were moved to the bottom.
	[
		"tabs",
		"agents",
		"teams",
		"projects",
		"pinned",
		"chats",
		"spaces",
		"channels",
		"integrations",
		"plugins",
		"companions",
		"identities",
		"workflows",
		"skills",
		"mcp",
		"tools",
		"engines",
		"archived",
	],
	// BEFORE `companions` (Apps) was promoted to sit directly under `agents`,
	// leaving `plugins` alone at the bottom. Every install that ever launched the
	// previous build has exactly this array persisted, so without this snapshot
	// reconcileSectionOrder would read it as "customised", preserve it verbatim,
	// and Apps would stay at the bottom for everyone but a fresh profile.
	[
		"tabs",
		"agents",
		"teams",
		"projects",
		"pinned",
		"chats",
		"spaces",
		"channels",
		"integrations",
		"identities",
		"workflows",
		"skills",
		"mcp",
		"tools",
		"engines",
		"archived",
		"plugins",
		"companions",
	],
	// Last default before Teams and Workflows became app-owned contributions.
	[
		"tabs",
		"agents",
		"companions",
		"teams",
		"projects",
		"pinned",
		"chats",
		"spaces",
		"channels",
		"integrations",
		"identities",
		"workflows",
		"skills",
		"mcp",
		"tools",
		"engines",
		"archived",
		"plugins",
	],
];

/** Human labels for the built-in sections, shared by the customize dialog. */
export const SECTION_LABELS = Object.fromEntries(
	BUILTIN_SECTIONS.map((section) => [section.key, section.label])
) as Record<BuiltinSectionKey, string>;

/** Glyphs for the tabbed-mode button bar plus app-owned compatibility keys.
 *
 * Teams and Workflows moved from compiled-in sections to app-registered sections,
 * but Native and older persisted layouts still resolve their canonical glyphs by
 * key. Keeping these two values here prevents a valid legacy/dynamic key from
 * handing `undefined` to an icon renderer while leaving ownership with the app. */
export const SECTION_ICONS = Object.fromEntries(
	BUILTIN_SECTIONS.map((section) => [section.key, section.icon])
) as Record<BuiltinSectionKey | "teams" | "workflows", IconSvgElement>;

SECTION_ICONS.teams = UserMultiple02Icon;
SECTION_ICONS.workflows = WorkflowCircle06Icon;

/** A dynamic app-registered section key (`plugin:<pluginId>:<sectionId>`). */
export function isDynamicSectionKey(value: string): value is DynamicSectionKey {
	return value.startsWith("plugin:");
}

export function isSectionKey(value: string): value is SectionKey {
	// Accept dynamic `plugin:` keys too, so a persisted order keeps an app's section
	// in place across reloads (it renders nothing when that app is disabled/absent).
	return (
		isDynamicSectionKey(value) ||
		(DEFAULT_SECTION_ORDER as string[]).includes(value)
	);
}

export function migrateLegacySectionKeys(values: string[]): string[] {
	return values.map(migrateLegacySectionKey);
}

export function migrateLegacySectionRecord<T>(
	values: Record<string, T>
): Record<string, T> {
	const migrated: Record<string, T> = {};
	for (const [key, value] of Object.entries(values)) {
		const nextKey = migrateLegacySectionKey(key);
		// A value already written under the dynamic key is newer than the legacy
		// alias and wins when both somehow survived a partial migration.
		if (!(nextKey in migrated) || key === nextKey) {
			migrated[nextKey] = value;
		}
	}
	return migrated;
}

interface SectionPreferenceStorage {
	getItem: (key: string) => string | null;
	setItem: (key: string, value: string) => void;
}

/** Rewrite the retired Teams/Workflows keys in every sidebar preference before
 * AppSidebar reads any of them. Arrays cover order/hidden/collapsed; records cover
 * page size and sort. Malformed or unavailable storage stays best-effort. */
export function migrateLegacySectionStorage(
	storage: SectionPreferenceStorage,
	keys: { arrays: readonly string[]; records: readonly string[] }
): void {
	try {
		for (const key of keys.arrays) {
			const raw = storage.getItem(key);
			if (!raw) {
				continue;
			}
			const parsed: unknown = JSON.parse(raw);
			if (
				!(
					Array.isArray(parsed) &&
					parsed.every((value) => typeof value === "string")
				)
			) {
				continue;
			}
			const migrated = migrateLegacySectionKeys(parsed);
			if (migrated.some((value, index) => value !== parsed[index])) {
				storage.setItem(key, JSON.stringify(migrated));
			}
		}
		for (const key of keys.records) {
			const raw = storage.getItem(key);
			if (!raw) {
				continue;
			}
			const parsed: unknown = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				continue;
			}
			const values = parsed as Record<string, unknown>;
			const migrated = migrateLegacySectionRecord(values);
			if (Object.keys(migrated).some((value) => !(value in values))) {
				storage.setItem(key, JSON.stringify(migrated));
			}
		}
	} catch {
		// localStorage and JSON parsing are best-effort, matching the loaders below.
	}
}

/**
 * Reconcile a stored order against the code. The stored order can drift from the
 * build (sections added/removed across versions, apps installed/uninstalled), so:
 * keep the stored order for known keys, drop unknown ones, and splice any section
 * the user has never seen back into its default neighbourhood (so a newly-added
 * section like Workflows lands next to Spaces rather than at the very bottom).
 *
 * Exported separately from {@link loadSectionOrder} so the reconciliation — the
 * part that must never lose a user's saved layout — is testable without a DOM.
 */
export function reconcileSectionOrder(parsed: string[]): SectionKey[] {
	const original = [...new Set(parsed)];
	if (
		LEGACY_DEFAULT_SECTION_ORDERS.some(
			(legacy) =>
				original.length === legacy.length &&
				original.every((key, index) => key === legacy[index])
		)
	) {
		return migrateLegacySectionKeys(
			LEGACY_DEFAULT_SECTION_ORDERS.at(-1) ?? DEFAULT_SECTION_ORDER
		).filter(isSectionKey);
	}
	const order = [
		...new Set(migrateLegacySectionKeys(parsed).filter(isSectionKey)),
	];
	const missing = DEFAULT_SECTION_ORDER.filter((k) => !order.includes(k));
	for (const key of missing) {
		const defaultIdx = DEFAULT_SECTION_ORDER.indexOf(key);
		// Anchor to the nearest already-present predecessor in the default order;
		// insert right after it, or at the front when there is none.
		let insertAt = 0;
		for (let i = defaultIdx - 1; i >= 0; i--) {
			const idx = order.indexOf(DEFAULT_SECTION_ORDER[i]);
			if (idx !== -1) {
				insertAt = idx + 1;
				break;
			}
		}
		order.splice(insertAt, 0, key);
	}
	return order;
}

export function loadSectionOrder(): SectionKey[] {
	try {
		const stored = localStorage.getItem(SECTION_ORDER_KEY);
		if (!stored) {
			return [...DEFAULT_SECTION_ORDER];
		}
		return reconcileSectionOrder(JSON.parse(stored) as string[]);
	} catch {
		return [...DEFAULT_SECTION_ORDER];
	}
}

export function saveSectionOrder(order: SectionKey[]) {
	try {
		localStorage.setItem(SECTION_ORDER_KEY, JSON.stringify(order));
	} catch {
		// best-effort
	}
}
