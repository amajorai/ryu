import { z } from "zod";

/** The small host seam shared by every sandboxed Companion entrypoint. */
export const COMPANION_THEME_TOKEN_NAMES = [
	// Semantic surface and status roles.
	"--background",
	"--foreground",
	"--card",
	"--card-foreground",
	"--popover",
	"--popover-foreground",
	"--primary",
	"--primary-foreground",
	"--secondary",
	"--secondary-foreground",
	"--muted",
	"--muted-foreground",
	"--accent",
	"--accent-foreground",
	"--destructive",
	"--success",
	"--success-foreground",
	"--warning",
	"--warning-foreground",
	"--info",
	"--info-foreground",
	"--border",
	"--input",
	"--ring",
	"--chart-1",
	"--chart-2",
	"--chart-3",
	"--chart-4",
	"--chart-5",
	"--sidebar",
	"--sidebar-foreground",
	"--sidebar-primary",
	"--sidebar-primary-foreground",
	"--sidebar-accent",
	"--sidebar-accent-foreground",
	"--sidebar-border",
	"--sidebar-ring",
	"--status-success",
	"--status-warning",
	"--status-info",
	"--status-destructive",
	// Shared appearance geometry and typography.
	"--radius",
	"--spacing",
	"--card-pad",
	"--card-pad-sm",
	"--ryu-ui-scale",
	"--ryu-window-radius-base",
	"--ryu-window-radius",
	"--font-sans",
	"--font-heading",
	"--font-mono",
	"--font-code",
	// Date/time display preferences are non-visual values, but they must cross
	// the null-origin boundary with the same first-paint snapshot as typography.
	"--ryu-timezone",
	"--ryu-locale",
	// Shared overlay geometry.
	"--ryu-popup-overlay-background",
	"--ryu-popup-overlay-blur",
	"--ryu-dialog-overlay-background",
	"--ryu-dialog-overlay-blur",
	// The page background customization is the visual backdrop for an app surface.
	"--ryu-page-bg-image",
	"--ryu-page-bg-repeat",
	"--ryu-page-bg-position",
	"--ryu-page-bg-size",
	"--ryu-page-bg-opacity",
	"--ryu-page-bg-blur",
	// Reserved state values are transported as CSS custom properties so the
	// existing token-only bridge remains backward-compatible.
	"--ryu-theme-mode",
	"--ryu-color-scheme",
	"--ryu-pointer-cursor",
	"--ryu-chrome-shadows",
	"--ryu-inverted-backgrounds",
	"--ryu-dialog-overlay-mode",
	"--ryu-popup-overlay-mode",
	"--ryu-animations",
	"--ryu-bg-active",
	"--ryu-high-contrast",
] as const;

/** Root attributes that can change the appearance snapshot without changing a CSS token. */
export const COMPANION_THEME_MUTATION_ATTRIBUTES = [
	"class",
	"style",
	"data-theme",
	"data-ryu-theme",
	"data-pointer-cursor",
	"data-chrome-shadows",
	"data-inverted-backgrounds",
	"data-dialog-overlay-blur",
	"data-popup-overlay-blur",
	"data-ryu-animations",
	"data-ryu-bg-active",
	"data-ryu-page-bg-active",
	"data-high-contrast",
] as const;

const THEME_TOKEN_NAME_RE = /^--[a-z0-9-]+$/;
const THEME_TOKEN_VALUE_UNSAFE_RE = /[{}<>;]/;
const themeTokenValueSchema = z
	.string()
	.min(1)
	.refine((value) => !THEME_TOKEN_VALUE_UNSAFE_RE.test(value));

interface CompanionThemeSubscribeOptions {
	onChange: (tokens: CompanionThemeTokens) => void;
}
interface CompanionThemeSubscription {
	dispose(): void;
}
/** Emits the complete resolved palette plus reserved appearance state. */
type CompanionThemeSubscribe = (
	options: CompanionThemeSubscribeOptions
) => CompanionThemeSubscription;

const companionThemeBridgeSchema = z.object({
	shell: z
		.object({
			// The trusted host owns the call signature; app bridges may expose
			// different services, so validate this callable seam independently.
			subscribeTheme: z
				.custom<CompanionThemeSubscribe>(
					(value) => z.function().safeParse(value).success
				)
				.optional(),
		})
		.optional(),
});

export type CompanionThemeBridge = z.output<typeof companionThemeBridgeSchema>;

const companionThemeEnvironmentSchema = z.object({
	ryu: z.unknown().optional(),
	window: z.object({ ryu: z.unknown().optional() }),
});

function readCompanionThemeBridge(): CompanionThemeBridge | undefined {
	if (globalThis.window === undefined) {
		return undefined;
	}
	const environment = companionThemeEnvironmentSchema.safeParse(globalThis);
	if (!environment.success) {
		return undefined;
	}
	const candidate = environment.data.window.ryu ?? environment.data.ryu;
	const parsed = companionThemeBridgeSchema.safeParse(candidate);
	return parsed.success ? parsed.data : undefined;
}

/** Resolved host CSS custom properties, including app-specific semantic tokens. */
export interface CompanionThemeTokens {
	[name: string]: string;
}

export interface CompanionThemeReadOptions {
	/** Use the desktop's local preference keys for first-paint state before boot effects run. */
	includeStoredPreferences?: boolean;
}

/** DOM operations consumed when marking a mounted app. */
export interface CompanionAppRoot {
	classList: Pick<DOMTokenList, "add">;
	dataset: DOMStringMap;
}
/** DOM operations consumed by live token and appearance projection. */
export interface CompanionThemeRoot {
	classList: Pick<DOMTokenList, "toggle">;
	removeAttribute(name: string): void;
	setAttribute(name: string, value: string): void;
	style: Pick<CSSStyleDeclaration, "setProperty">;
}
/** DOM and browser services consumed when capturing first-paint preferences. */
export interface CompanionThemeReadRoot {
	classList: Pick<DOMTokenList, "contains">;
	getAttribute(name: string): string | null;
	ownerDocument?: {
		defaultView: {
			getComputedStyle(
				root: CompanionThemeReadRoot
			): Pick<CSSStyleDeclaration, "getPropertyValue">;
			localStorage: Pick<Storage, "getItem">;
			navigator: Pick<Navigator, "language">;
		} | null;
	};
}

export type CompanionAppSurface = "standard" | "editor" | "canvas";

/** Mark a mounted Companion root as using the fixed Ryu App UI contract. */
export function markCompanionAppRoot(
	root: CompanionAppRoot | null,
	options: { surface?: CompanionAppSurface } = {}
): void {
	if (!root) {
		return;
	}
	root.dataset.ryuAppUi = "v1";
	root.dataset.ryuSurface = options.surface ?? "standard";
	root.classList.add("ryu-app-root");
}

function setStateAttribute(
	root: CompanionThemeRoot,
	attribute: string,
	value: string | undefined,
	activeValue: string
): void {
	if (value === undefined) {
		return;
	}
	if (value === activeValue) {
		root.setAttribute(attribute, activeValue);
	} else {
		root.removeAttribute(attribute);
	}
}

function systemTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

/** Apply reserved appearance metadata carried alongside the CSS tokens. */
function applyCompanionThemeState(
	tokens: CompanionThemeTokens,
	root: CompanionThemeRoot
): void {
	const mode = tokens["--ryu-theme-mode"];
	if (mode === "dark" || mode === "light") {
		root.classList.toggle("dark", mode === "dark");
		root.classList.toggle("light", mode === "light");
		root.setAttribute("data-ryu-theme", mode);
	}

	const colorScheme = tokens["--ryu-color-scheme"];
	if (colorScheme === "dark" || colorScheme === "light") {
		root.style.setProperty("color-scheme", colorScheme);
	}
	setStateAttribute(
		root,
		"data-pointer-cursor",
		tokens["--ryu-pointer-cursor"],
		"true"
	);
	setStateAttribute(
		root,
		"data-chrome-shadows",
		tokens["--ryu-chrome-shadows"],
		"off"
	);
	setStateAttribute(
		root,
		"data-inverted-backgrounds",
		tokens["--ryu-inverted-backgrounds"],
		"on"
	);
	setStateAttribute(
		root,
		"data-dialog-overlay-blur",
		tokens["--ryu-dialog-overlay-mode"],
		"off"
	);
	setStateAttribute(
		root,
		"data-popup-overlay-blur",
		tokens["--ryu-popup-overlay-mode"],
		"on"
	);
	setStateAttribute(
		root,
		"data-ryu-animations",
		tokens["--ryu-animations"],
		"off"
	);
	setStateAttribute(
		root,
		"data-ryu-bg-active",
		tokens["--ryu-bg-active"],
		"on"
	);
	setStateAttribute(
		root,
		"data-ryu-page-bg-active",
		tokens["--ryu-page-bg-active"],
		"on"
	);
	setStateAttribute(
		root,
		"data-high-contrast",
		tokens["--ryu-high-contrast"],
		"on"
	);
}

/**
 * Read the host's complete appearance snapshot for a sandboxed Companion.
 *
 * The host sends computed semantic values rather than a preset id because a
 * user may be using a custom or marketplace-provided palette. Reserved
 * `--ryu-*` values carry the root state that CSS alone cannot infer in a
 * null-origin document (explicit dark mode, pointer cursor, motion, and
 * overlay preferences).
 */
export function readCompanionThemeTokens(
	root: CompanionThemeReadRoot | null = globalThis.document === undefined
		? null
		: document.documentElement,
	options: CompanionThemeReadOptions = {}
): CompanionThemeTokens {
	if (!root) {
		return {};
	}
	const view = root.ownerDocument?.defaultView;
	const computed = view?.getComputedStyle(root);
	const tokens: CompanionThemeTokens = {};
	for (const name of COMPANION_THEME_TOKEN_NAMES) {
		const value = computed?.getPropertyValue(name).trim() ?? "";
		if (value.length > 0) {
			tokens[name] = value;
		}
	}
	// `--card-pad` is intentionally absent when the user has not selected an
	// explicit Card padding. Send the derived value so a previous live override
	// cannot remain stuck in a mounted frame after Reset Appearance.
	tokens["--card-pad"] ??= "calc(var(--spacing) * 4)";
	tokens["--card-pad-sm"] ??= "calc(var(--spacing) * 3)";
	tokens["--ryu-ui-scale"] ??= "1";

	const mode = root.classList.contains("dark") ? "dark" : "light";
	tokens["--ryu-theme-mode"] = mode;
	tokens["--ryu-color-scheme"] = mode;
	const attributeValue = (name: string): string | undefined =>
		root.getAttribute(name) ?? undefined;
	const storedValue = (key: string): string | null => {
		if (!options.includeStoredPreferences) {
			return null;
		}
		try {
			return view?.localStorage?.getItem(key) ?? null;
		} catch {
			return null;
		}
	};
	const hostTimezone = computed?.getPropertyValue("--ryu-timezone").trim();
	const storedTimezone = storedValue("ryu:timezone");
	const timezone =
		storedTimezone && storedTimezone !== "system"
			? storedTimezone
			: hostTimezone && hostTimezone !== "system"
				? hostTimezone
				: systemTimeZone();
	tokens["--ryu-timezone"] = timezone;
	const locale = computed?.getPropertyValue("--ryu-locale").trim();
	tokens["--ryu-locale"] =
		locale && locale !== "system"
			? locale
			: view?.navigator.language || "en-US";
	tokens["--ryu-pointer-cursor"] =
		attributeValue("data-pointer-cursor") === "true" ||
		storedValue("ryu_pointer_cursor") === "true"
			? "true"
			: "false";
	tokens["--ryu-chrome-shadows"] =
		attributeValue("data-chrome-shadows") === "off" ||
		storedValue("ryu_chrome_shadows") === "false"
			? "off"
			: "on";
	tokens["--ryu-inverted-backgrounds"] =
		attributeValue("data-inverted-backgrounds") === "on" ||
		storedValue("ryu_inverted_backgrounds") === "true"
			? "on"
			: "off";
	tokens["--ryu-dialog-overlay-mode"] =
		attributeValue("data-dialog-overlay-blur") === "off" ||
		(options.includeStoredPreferences &&
			storedValue("ryu_dialog_overlay_blur") !== "true")
			? "off"
			: "on";
	tokens["--ryu-popup-overlay-mode"] =
		attributeValue("data-popup-overlay-blur") === "on" ||
		storedValue("ryu_popup_overlay_blur") === "true"
			? "on"
			: "off";
	let storedAnimationsDisabled = false;
	storedAnimationsDisabled = storedValue("ryu:animations-enabled") === "false";
	const animationsEnabled =
		attributeValue("data-ryu-animations") !== "off" &&
		!storedAnimationsDisabled;
	tokens["--ryu-animations"] = animationsEnabled ? "on" : "off";
	tokens["--ryu-bg-active"] =
		attributeValue("data-ryu-bg-active") === "true" ? "on" : "off";
	const pageBackgroundImage = tokens["--ryu-page-bg-image"];
	const pageBackgroundOpacity = tokens["--ryu-page-bg-opacity"];
	const pageBackgroundBlur = tokens["--ryu-page-bg-blur"];
	tokens["--ryu-page-bg-active"] =
		(pageBackgroundImage !== undefined && pageBackgroundImage !== "none") ||
		(pageBackgroundOpacity !== undefined && pageBackgroundOpacity !== "1") ||
		(pageBackgroundBlur !== undefined && pageBackgroundBlur !== "0px")
			? "on"
			: "off";
	tokens["--ryu-high-contrast"] =
		attributeValue("data-high-contrast") === "on" ? "on" : "off";
	return tokens;
}

/** Apply only valid CSS custom-property tokens from the trusted host. */
export function applyCompanionThemeTokens(
	tokens: CompanionThemeTokens,
	root: CompanionThemeRoot | null = globalThis.document === undefined
		? null
		: document.documentElement
): void {
	if (!root) {
		return;
	}
	for (const [name, value] of Object.entries(tokens)) {
		const parsed = themeTokenValueSchema.safeParse(value);
		if (THEME_TOKEN_NAME_RE.test(name) && parsed.success) {
			root.style.setProperty(name, parsed.data);
		}
	}
	applyCompanionThemeState(tokens, root);
}

/** Subscribe to the live host theme. Safe to call before a bridge exists. */
export function subscribeCompanionTheme(
	bridge: CompanionThemeBridge | undefined = readCompanionThemeBridge(),
	root: CompanionThemeRoot | null = globalThis.document === undefined
		? null
		: document.documentElement
): () => void {
	const subscribeTheme = bridge?.shell?.subscribeTheme;
	if (!subscribeTheme) {
		return () => undefined;
	}
	const subscription = subscribeTheme({
		onChange: (tokens) => applyCompanionThemeTokens(tokens, root),
	});
	return () => subscription.dispose();
}
