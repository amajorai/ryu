import type { AvatarConversationState } from "@ryu/ui/components/avatar-conversation.tsx";
import type { GradientDirection } from "@ryu/ui/components/dither-kit/gradient.tsx";
import { isDitherColor } from "@ryu/ui/components/dither-kit/palette.ts";
import type { ExpressiveExpressionSelection } from "@ryu/ui/components/expressive.ts";
import type { ExpressiveAnimationSelection } from "@ryu/ui/components/expressive-animation.ts";
import {
	type GhostAvatarAppearance,
	parseGhostAvatar,
} from "@ryu/ui/components/ghost-avatar.ts";
import type { GlyphDitherValue, GlyphValue } from "@ryu/ui/components/glyph.ts";
import { GlyphDisplay } from "@ryu/ui/components/glyph-display.tsx";
import { Logo as RyuLogo } from "@ryu/ui/components/logo.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ComponentType, CSSProperties } from "react";
import { z } from "zod";

type LogoConfig =
	| { kind: "single"; src: string; invert: boolean }
	| { kind: "themed"; light: string; dark: string };

/**
 * Brand marks for REGISTRY agents — the ones a user installs from the catalog
 * rather than the engines Ryu ships with. Slugs, resolved to
 * `/assets/logos/<slug>.svg` by {@link registryLogoConfig}.
 *
 * This is the same table the catalog row renders from (`REGISTRY_SVGL` in
 * `agent-catalog-logo.tsx`, which now re-exports this one). It lives HERE
 * because the catalog is not the only place these agents appear: installing
 * Cursor auto-creates a Cursor agent, and every surface that then draws it —
 * sidebar row, composer picker, agent editor — goes through {@link AgentLogo},
 * which knew only about `ENGINE_LOGOS` and so drew the Ryu ghost for all of them.
 *
 * Keys are registry agent ids, which is also what `normalizeEngine` yields for
 * an `acp:<id>` engine string.
 *
 * A `{light, dark}` pair is only for marks with achromatic parts that vanish
 * against the opposite surface (kimi's panel, mistral's unfilled squares). Solid
 * brand colours (amp's blue, jetbrains' gradient) stay single-asset — a dark
 * variant would only mis-colour them.
 */
export const REGISTRY_LOGO_SLUGS = {
	"amp-acp": "amp",
	cursor: { light: "cursor_light", dark: "cursor_dark" },
	"github-copilot-cli": { light: "copilot", dark: "copilot_dark" },
	"grok-build": { light: "grok-light", dark: "grok-dark" },
	junie: "jetbrains",
	kilo: { light: "kilocode-light", dark: "kilocode-dark" },
	kimi: { light: "kimi-icon", dark: "kimi-icon-dark" },
	"mistral-vibe": { light: "mistral-ai_logo", dark: "mistral-ai_logo_dark" },
	opencode: { light: "opencode", dark: "opencode-dark" },
	"qwen-code": { light: "qwen_light", dark: "qwen_dark" },
	// Curated agents (no ACP registry entry) that bundle an upstream brand mark.
	// Keys are the `acp:`-stripped engine id, which is what `normalizeEngine`
	// yields for these entries. Sources: svgl (docker), the agent's own site
	// favicon/brand asset (openhands, blackbox, prime, localharness, agentpool),
	// or the upstream repo's mark (raxol, bub).
	agentpool: "agentpool",
	blackbox: "blackbox",
	bub: "bub",
	"docker-agent": "docker",
	localharness: "localharness",
	openhands: "openhands",
	prime: "prime",
	raxol: "raxol",
} satisfies Record<string, string | { light: string; dark: string }>;

/** The registry brand mark for an agent id, as a {@link LogoConfig}. */
const registryLogoSchema = z.union([
	z.string().transform((slug) => ({
		kind: "single" as const,
		src: `/assets/logos/${slug}.svg`,
		invert: false,
	})),
	z.object({ light: z.string(), dark: z.string() }).transform((slugs) => ({
		kind: "themed" as const,
		light: `/assets/logos/${slugs.light}.svg`,
		dark: `/assets/logos/${slugs.dark}.svg`,
	})),
]) satisfies z.ZodType<LogoConfig>;
const registryLogos = new Map(
	Object.entries(REGISTRY_LOGO_SLUGS).map(
		([key, slug]): [string, LogoConfig] => [key, registryLogoSchema.parse(slug)]
	)
);
function registryLogoConfig(key: string) {
	return registryLogos.get(key);
}

/** Registry agents that ship a brand mark of their own. */
export function hasRegistryLogo(key: string | null | undefined): boolean {
	return key != null && key in REGISTRY_LOGO_SLUGS;
}

const ENGINE_LOGOS = {
	claude: {
		kind: "single",
		src: "/assets/logos/claude.svg",
		invert: false,
	},
	anthropic: {
		kind: "themed",
		light: "/assets/logos/anthropic_black.svg",
		dark: "/assets/logos/anthropic_white.svg",
	},
	codex: {
		kind: "themed",
		light: "/assets/logos/openai_light.svg",
		dark: "/assets/logos/openai_dark.svg",
	},
	openai: {
		kind: "themed",
		light: "/assets/logos/openai_light.svg",
		dark: "/assets/logos/openai_dark.svg",
	},
	gemini: {
		kind: "themed",
		light: "/assets/logos/gemini_light.svg",
		dark: "/assets/logos/gemini_dark.svg",
	},
	mistral: {
		kind: "single",
		src: "/assets/logos/mistral.svg",
		invert: false,
	},
	pi: {
		// pi.dev (the coding agent, `pi-acp`), NOT Inflection AI's Pi assistant. The
		// mark is a monochrome `currentColor` glyph → `invert` flips it white on dark.
		kind: "single",
		src: "/assets/logos/pi.svg",
		invert: true,
	},
	inflection: {
		kind: "themed",
		light: "/assets/logos/inflectionai_light.svg",
		dark: "/assets/logos/inflectionai_dark.svg",
	},
	ollama: {
		kind: "themed",
		light: "/assets/logos/ollama_light.svg",
		dark: "/assets/logos/ollama_dark.svg",
	},
	local: {
		kind: "themed",
		light: "/assets/logos/ollama_light.svg",
		dark: "/assets/logos/ollama_dark.svg",
	},
	ryu: {
		kind: "themed",
		light: "/assets/logos/ryu_light.svg",
		dark: "/assets/logos/ryu_dark.svg",
	},
	openclaw: {
		// The lobster mark from openclaw.ai/favicon.svg. Solid brand red on both
		// themes, so it stays single-asset — the old themed pair was a generic
		// circle glyph with nothing OpenClaw about it.
		kind: "single",
		src: "/assets/logos/openclaw.svg",
		invert: false,
	},
	hermes: {
		kind: "themed",
		light: "/assets/logos/hermes_light.svg",
		dark: "/assets/logos/hermes_dark.svg",
	},
} satisfies Record<string, LogoConfig>;

export function hasBrandedEngineLogo(
	engine: string | null | undefined
): boolean {
	const key = normalizeEngine(engine);
	// Registry marks count as branded now that `AgentLogo` can draw them —
	// otherwise callers that use this to decide "does it need a fallback?" would
	// still route a Cursor agent to a generic mark.
	return key != null && (key in ENGINE_LOGOS || hasRegistryLogo(key));
}

/** Strip the "acp:" transport prefix and lowercase so "acp:Claude" → "claude". */
export function normalizeEngine(
	engine: string | null | undefined
): string | null {
	if (!engine) {
		return null;
	}
	const raw = engine.startsWith("acp:") ? engine.slice(4) : engine;
	return raw.toLowerCase();
}

/**
 * The engine key to brand an agent by. Prefers the agent's declared engine,
 * then falls back to the agent id for built-ins (so the flagship "ryu" brands
 * as Ryu). Mirrors the derivation used by the composer agent picker.
 */
export function engineForAgent(agent: {
	engine?: string | null;
	builtIn?: boolean | null;
	id: string;
}): string | null {
	return agent.engine ?? (agent.builtIn ? agent.id : null);
}

/**
 * Static light-theme logo path for an engine, for surfaces that need a bitmap
 * source rather than a React node (OS notifications). Mirrors {@link AgentLogo}'s
 * lookup order and falls back to the Ryu mark.
 */
export function agentLogoSrc(engine: string | null | undefined): string {
	const key = normalizeEngine(engine);
	const known =
		(key
			? Object.entries(ENGINE_LOGOS).find(
					([engineKey]) => engineKey === key
				)?.[1]
			: undefined) ?? (key ? registryLogoConfig(key) : undefined);
	if (!known) {
		return ENGINE_LOGOS.ryu.light;
	}
	return known.kind === "single" ? known.src : known.light;
}

/**
 * Renders the provider logo for a given engine id. Unknown / unbranded engines
 * (custom agents, Factory droid, etc.) fall back to the Ryu logo — Ryu is the
 * car around any engine, so its own mark is the sensible default.
 */
export function AgentLogo({
	engine,
	className,
	size,
	presentation = "default",
	fit,
}: {
	engine?: string | null;
	presentation?: "default" | "portrait" | "compact";
	fit?: "cover" | "contain";
	className?: string;
	/** Explicit pixel size (e.g. "48px"). Required for the Ryu component path. */
	size?: string;
}) {
	const key = normalizeEngine(engine);
	// `ENGINE_LOGOS` first, then the CATALOG's brand marks. Both are needed: the
	// catalog's marks are keyed by registry agent id (`cursor`, `opencode`,
	// `qwen-code`, …) and were only ever consulted while rendering a catalog ROW,
	// so an agent auto-created by installing one of those — which is what happens
	// when you install Cursor — resolved through this function, missed, and fell
	// back to the Ryu ghost. The logo was set the whole time; nothing downstream of
	// the catalog looked at it. `normalizeEngine` strips the `acp:` prefix, so an
	// agent whose engine is `acp:cursor` matches the `cursor` entry directly.
	const known =
		(key
			? Object.entries(ENGINE_LOGOS).find(
					([engineKey]) => engineKey === key
				)?.[1]
			: undefined) ?? (key ? registryLogoConfig(key) : undefined);

	// Ryu (and any unbranded engine that falls back to it) renders via the logo
	// component's `outline` variant on sized surfaces: the static SVG's tight
	// `0 0 24 24` viewBox clips the stroked ghost's right edge, while the
	// component sets overflow:visible.
	if ((!known || key === "ryu") && size) {
		return (
			<RyuLogo
				className={className}
				corners={
					presentation === "portrait"
						? "circle"
						: presentation === "compact"
							? "compact"
							: "default"
				}
				size={size}
				variant="outline"
			/>
		);
	}

	const config = known ?? ENGINE_LOGOS.ryu;
	const alt = key ?? "ryu";
	const imageClassName = cn(
		className,
		presentation === "portrait" && "rounded-full object-cover",
		presentation === "compact" && "rounded-glyph-compact object-contain",
		fit === "contain" && "object-contain",
		fit === "cover" && "object-cover"
	);
	const style: CSSProperties & { "--agent-logo-size"?: string } = size
		? { "--agent-logo-size": size }
		: {};

	if (config.kind === "themed") {
		return (
			<>
				{/* bundled engine logo */}
				<img
					alt={alt}
					className={cn(
						imageClassName,
						size && "size-(--agent-logo-size)",
						"block dark:hidden"
					)}
					draggable={false}
					src={config.light}
					style={style}
				/>
				{/* bundled engine logo */}
				<img
					alt={alt}
					className={cn(
						imageClassName,
						size && "size-(--agent-logo-size)",
						"hidden dark:block"
					)}
					draggable={false}
					src={config.dark}
					style={style}
				/>
			</>
		);
	}

	return (
		// bundled engine logo
		<img
			alt={alt}
			className={cn(
				imageClassName,
				size && "size-(--agent-logo-size)",
				config.invert && "dark:invert"
			)}
			draggable={false}
			src={config.src}
			style={style}
		/>
	);
}

/** A dither-gradient avatar spec as stored on `persona.dither`. Kept structural
 * (not the `AgentPersona` type) so this leaf module stays free of the API layer. */
export interface AvatarDitherSpec {
	direction?: string | null;
	from?: string | null;
	to?: string | null;
}

const DITHER_DIRECTIONS: GradientDirection[] = ["up", "down", "left", "right"];

/** A DiceBear avatar spec as stored on `persona.dicebear`. */
export interface AvatarDicebearSpec {
	seed?: string | null;
	style?: string | null;
}

/** An expressive Ryu ghost selection as stored on `persona.expressive`. */
export interface AvatarExpressiveSpec extends GhostAvatarAppearance {
	animation?: ExpressiveAnimationSelection | null;
	expression?: ExpressiveExpressionSelection | null;
}

/**
 * Fold persona avatar fields into a {@link GlyphValue} for {@link GlyphDisplay}.
 * Priority: avatar_url → expressive → emoji (+ optional dither bg) → icon
 * (+ optional dither bg) → dicebear → dither-only.
 */
export function personaToGlyph(persona: {
	avatarUrl?: string | null;
	dicebear?: AvatarDicebearSpec | null;
	dither?: AvatarDitherSpec | null;
	emoji?: string | null;
	expressive?: AvatarExpressiveSpec | null;
	icon?: string | null;
	iconColor?: string | null;
}): GlyphValue {
	if (persona.avatarUrl) {
		return { kind: "avatar", dataUrl: persona.avatarUrl };
	}
	const expressive = parseGhostAvatar(persona.expressive);
	if (expressive) {
		return { ...expressive, kind: "expressive" };
	}
	const ditherLayer: GlyphDitherValue | undefined =
		persona.dither && isDitherColor(persona.dither.from)
			? {
					from: persona.dither.from,
					to: isDitherColor(persona.dither.to) ? persona.dither.to : null,
					direction:
						DITHER_DIRECTIONS.find((d) => d === persona.dither?.direction) ??
						"up",
				}
			: undefined;
	if (persona.emoji) {
		const glyph: Extract<GlyphValue, { kind: "emoji" }> = {
			kind: "emoji",
			emoji: persona.emoji,
		};
		if (ditherLayer) {
			glyph.dither = ditherLayer;
		}
		return glyph;
	}
	if (persona.icon) {
		const glyph: Extract<GlyphValue, { kind: "icon" }> = {
			kind: "icon",
			id: persona.icon,
		};
		if (persona.iconColor) {
			glyph.color = persona.iconColor;
		}
		if (ditherLayer) {
			glyph.dither = ditherLayer;
		}
		return glyph;
	}
	if (persona.dicebear?.style && persona.dicebear.seed) {
		return {
			kind: "dicebear",
			style: persona.dicebear.style,
			seed: persona.dicebear.seed,
		};
	}
	if (ditherLayer) {
		return { kind: "dither", dither: ditherLayer };
	}
	return null;
}

/**
 * Renders an agent's avatar, resolving the persona's avatar source in priority
 * order: uploaded image → expressive → emoji → icon → DiceBear → dither → engine logo.
 * Use this at every call site that shows "an agent" so a custom avatar wins
 * over the engine default consistently.
 */
export function AgentAvatar({
	avatarUrl,
	glyph,
	emoji,
	icon,
	iconColor,
	dicebear,
	dither,
	expressive,
	engine,
	className,
	thinking = false,
	conversationState,
	size,
	presentation = "default",
	fit,
}: {
	avatarUrl?: string | null;
	presentation?: "default" | "portrait" | "compact";
	fit?: "cover" | "contain";
	className?: string;
	dicebear?: AvatarDicebearSpec | null;
	dither?: AvatarDitherSpec | null;
	emoji?: string | null;
	expressive?: AvatarExpressiveSpec | null;
	engine?: string | null;
	glyph?: GlyphValue;
	icon?: string | null;
	iconColor?: string | null;
	/** Force the expressive ghost into its orbit animation for a live thinking row. */
	thinking?: boolean;
	conversationState?: AvatarConversationState;
	size?: string;
}) {
	const parsed = size ? Number.parseInt(size, 10) : Number.NaN;
	const px = Number.isNaN(parsed) ? 16 : parsed;
	const resolvedGlyph =
		glyph ??
		personaToGlyph({
			avatarUrl,
			emoji,
			icon,
			iconColor,
			dicebear,
			dither,
			expressive,
		});
	if (resolvedGlyph) {
		// A persona glyph always inherits its container's corners and fill:
		// `presentation` and `fit` shape only the engine-logo fallback below, so a
		// compact row or portrait tile cannot re-crop an uploaded avatar.
		return (
			<GlyphDisplay
				alt="agent avatar"
				className={className}
				conversationState={conversationState}
				corners="inherit"
				size={px}
				thinking={thinking}
				value={resolvedGlyph}
			/>
		);
	}
	return (
		<AgentLogo
			className={className}
			engine={engine}
			fit={fit}
			presentation={presentation}
			size={size}
		/>
	);
}

// Stable icon cache for AgentAvatar, keyed by avatar+engine so ModeOption.icon
// keeps a stable reference across renders (see getEngineIcon).
const agentIconCache = new Map<string, ComponentType<{ className?: string }>>();

/**
 * Stable ComponentType<{ className? }> for use in ModeOption.icon that honors a
 * custom avatar (image, icon, or dither gradient), falling back to the engine
 * logo. Mirrors getEngineIcon.
 */
export function getAgentIcon(
	avatarUrl: string | null | undefined,
	engine: string | null | undefined,
	icon?: string | null,
	dither?: AvatarDitherSpec | null,
	glyph?: GlyphValue
): ComponentType<{ className?: string }> {
	if (glyph) {
		const cacheKey = `glyph:${JSON.stringify(glyph)}|engine:${engine ?? ""}`;
		if (!agentIconCache.has(cacheKey)) {
			const eng = engine;
			const AvatarIcon = ({ className }: { className?: string }) => (
				<AgentAvatar
					className={className}
					engine={eng}
					glyph={glyph}
					size="16px"
				/>
			);
			agentIconCache.set(cacheKey, AvatarIcon);
		}
		// just set above when missing
		return agentIconCache.get(cacheKey)!;
	}
	if (!(avatarUrl || icon || dither)) {
		return getEngineIcon(engine);
	}
	const ditherKey = dither
		? `${dither.from ?? ""}:${dither.to ?? ""}:${dither.direction ?? ""}`
		: "";
	const cacheKey = `avatar:${avatarUrl ?? ""}|icon:${icon ?? ""}|dither:${ditherKey}`;
	if (!agentIconCache.has(cacheKey)) {
		const url = avatarUrl;
		const iconId = icon;
		const ditherSpec = dither;
		const eng = engine;
		const AvatarIcon = ({ className }: { className?: string }) => (
			<AgentAvatar
				avatarUrl={url}
				className={className}
				dither={ditherSpec}
				engine={eng}
				icon={iconId}
				size="16px"
			/>
		);
		agentIconCache.set(cacheKey, AvatarIcon);
	}
	// just set above when missing
	return agentIconCache.get(cacheKey)!;
}

export interface AgentAvatarMember {
	avatarUrl?: string | null;
	dither?: AvatarDitherSpec | null;
	engine?: string | null;
	glyph?: GlyphValue;
	icon?: string | null;
	id: string;
}

/** Overlapping agent avatars (custom image when set, else engine logo). */
export function AgentAvatarStack({
	members,
	className,
	size = "sm",
}: {
	members: AgentAvatarMember[];
	className?: string;
	/** `sm` fits sidebar rows (16px slot); `xs` for nested member rows. */
	size?: "sm" | "xs";
}) {
	const shown = members.slice(0, 3);
	if (shown.length === 0) {
		return (
			<AgentAvatar
				className={cn("shrink-0 object-contain", className)}
				engine={null}
				size={size === "xs" ? "12px" : "16px"}
			/>
		);
	}
	const outer = size === "xs" ? "size-3" : "size-4";
	const logo = size === "xs" ? "10px" : "12px";
	const overlap = size === "xs" ? "-ml-1" : "-ml-1.5";
	return (
		<span className={cn("inline-flex shrink-0 items-center", className)}>
			{shown.map((member, i) => (
				<span
					className={cn(
						"flex items-center justify-center rounded-full bg-background ring-1 ring-border",
						outer,
						i > 0 && overlap,
						shown.length - i === 3
							? "z-3"
							: shown.length - i === 2
								? "z-2"
								: "z-1"
					)}
					key={member.id}
				>
					<AgentAvatar
						avatarUrl={member.avatarUrl}
						className="object-contain"
						dither={member.dither}
						engine={member.engine}
						glyph={member.glyph}
						icon={member.icon}
						size={shown.length === 1 && size === "sm" ? "16px" : logo}
					/>
				</span>
			))}
		</span>
	);
}

/** An overlapping row of member engine logos for a team — no card chrome. */
export function AgentLogoStack({
	engines,
	className,
}: {
	engines: (string | null)[];
	className?: string;
}) {
	const shown = engines.slice(0, 3);
	if (shown.length === 0) {
		return <AgentLogo className={className} engine={null} />;
	}
	// Disambiguate repeated engines (a team can have two Ryu members) so keys are
	// stable without falling back to the array index.
	const counts = new Map<string, number>();
	const items = shown.map((eng) => {
		const base = normalizeEngine(eng) ?? "ryu";
		const n = (counts.get(base) ?? 0) + 1;
		counts.set(base, n);
		return { engine: eng, key: `${base}-${n}` };
	});
	return (
		<span className={cn("inline-flex shrink-0 items-center", className)}>
			{items.map((item, i) => (
				<AgentLogo
					className={cn("size-4 shrink-0", i > 0 && "-ml-1.5")}
					engine={item.engine}
					key={item.key}
					size="16px"
				/>
			))}
		</span>
	);
}

const teamIconCache = new Map<string, ComponentType<{ className?: string }>>();

/** Stable ModeOption.icon rendering a team's members as an overlapping stack. */
export function getTeamStackIcon(
	engines: (string | null)[]
): ComponentType<{ className?: string }> {
	const cacheKey = engines.map((e) => normalizeEngine(e) ?? "ryu").join(",");
	if (!teamIconCache.has(cacheKey)) {
		const list = engines;
		const Icon = () => <AgentLogoStack className="mt-0.5" engines={list} />;
		teamIconCache.set(cacheKey, Icon);
	}
	// just set above when missing
	return teamIconCache.get(cacheKey)!;
}

// Stable icon component cache — prevents ModeOption.icon from being a new
// function reference on every render, which would cause ModeSelector to
// unmount/remount the icon on each parent re-render.
const engineIconCache = new Map<
	string,
	ComponentType<{ className?: string }>
>();

/**
 * Returns a stable ComponentType<{ className? }> for use in ModeOption.icon.
 * Cached by engine key so the reference is stable across renders.
 */
export function getEngineIcon(
	engine: string | null | undefined
): ComponentType<{ className?: string }> {
	const cacheKey = normalizeEngine(engine) ?? "__fallback__";
	const cached = engineIconCache.get(cacheKey);
	if (cached) {
		return cached;
	}
	{
		const eng = engine;
		const Icon = ({ className }: { className?: string }) => (
			<AgentLogo className={className} engine={eng} size="16px" />
		);
		engineIconCache.set(cacheKey, Icon);
		return Icon;
	}
}
