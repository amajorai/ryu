import { Logo as RyuLogo } from "@ryu/ui/components/logo";
import { cn } from "@ryu/ui/lib/utils";
import type { ComponentType } from "react";

type LogoConfig =
	| { kind: "single"; src: string; invert: boolean }
	| { kind: "themed"; light: string; dark: string };

const ENGINE_LOGOS: Record<string, LogoConfig> = {
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
		kind: "themed",
		light: "/assets/logos/inflectionai_light.svg",
		dark: "/assets/logos/inflectionai_dark.svg",
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
		kind: "themed",
		light: "/assets/logos/openclaw_light.svg",
		dark: "/assets/logos/openclaw_dark.svg",
	},
	hermes: {
		kind: "themed",
		light: "/assets/logos/hermes_light.svg",
		dark: "/assets/logos/hermes_dark.svg",
	},
};

export function hasBrandedEngineLogo(
	engine: string | null | undefined
): boolean {
	const key = normalizeEngine(engine);
	return key != null && key in ENGINE_LOGOS;
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
 * Renders the provider logo for a given engine id. Unknown / unbranded engines
 * (custom agents, Factory droid, etc.) fall back to the Ryu logo — Ryu is the
 * car around any engine, so its own mark is the sensible default.
 */
export function AgentLogo({
	engine,
	className,
	size,
}: {
	engine?: string | null;
	className?: string;
	/** Explicit pixel size (e.g. "48px"). Required for the Ryu component path. */
	size?: string;
}) {
	const key = normalizeEngine(engine);
	const known = key ? ENGINE_LOGOS[key] : undefined;

	// Ryu (and any unbranded engine that falls back to it) renders via the logo
	// component's `outline` variant on sized surfaces: the static SVG's tight
	// `0 0 24 24` viewBox clips the stroked ghost's right edge, while the
	// component sets overflow:visible.
	if ((!known || key === "ryu") && size) {
		return <RyuLogo className={className} size={size} variant="outline" />;
	}

	const config = known ?? ENGINE_LOGOS.ryu;
	const alt = key ?? "ryu";
	const style = size ? { width: size, height: size } : undefined;

	if (config.kind === "themed") {
		return (
			<>
				{/* biome-ignore lint/performance/noImgElement lint/correctness/useImageSize: bundled engine logo */}
				<img
					alt={alt}
					className={cn(className, "block dark:hidden")}
					draggable={false}
					src={config.light}
					style={style}
				/>
				{/* biome-ignore lint/performance/noImgElement lint/correctness/useImageSize: bundled engine logo */}
				<img
					alt={alt}
					className={cn(className, "hidden dark:block")}
					draggable={false}
					src={config.dark}
					style={style}
				/>
			</>
		);
	}

	return (
		// biome-ignore lint/performance/noImgElement lint/correctness/useImageSize: bundled engine logo
		<img
			alt={alt}
			className={cn(className, config.invert && "dark:invert")}
			draggable={false}
			src={config.src}
			style={style}
		/>
	);
}

/**
 * Renders an agent's avatar: the user's custom image (a data URL on
 * `persona.avatar_url`) when set, otherwise the branded engine logo. Use this at
 * every call site that shows "an agent" so a custom avatar wins over the engine
 * default consistently (sidebar rows, picker items, etc.).
 */
export function AgentAvatar({
	avatarUrl,
	engine,
	className,
	size,
}: {
	avatarUrl?: string | null;
	engine?: string | null;
	className?: string;
	size?: string;
}) {
	if (avatarUrl) {
		const style = size ? { width: size, height: size } : undefined;
		return (
			// biome-ignore lint/performance/noImgElement lint/correctness/useImageSize: user avatar data URL
			<img
				alt="agent avatar"
				className={cn(className, "object-cover")}
				draggable={false}
				src={avatarUrl}
				style={style}
			/>
		);
	}
	return <AgentLogo className={className} engine={engine} size={size} />;
}

// Stable icon cache for AgentAvatar, keyed by avatar+engine so ModeOption.icon
// keeps a stable reference across renders (see getEngineIcon).
const agentIconCache = new Map<string, ComponentType<{ className?: string }>>();

/**
 * Stable ComponentType<{ className? }> for use in ModeOption.icon that honors a
 * custom avatar, falling back to the engine logo. Mirrors getEngineIcon.
 */
export function getAgentIcon(
	avatarUrl: string | null | undefined,
	engine: string | null | undefined
): ComponentType<{ className?: string }> {
	if (!avatarUrl) {
		return getEngineIcon(engine);
	}
	const cacheKey = `avatar:${avatarUrl}`;
	if (!agentIconCache.has(cacheKey)) {
		const url = avatarUrl;
		const eng = engine;
		const Icon = ({ className }: { className?: string }) => (
			<AgentAvatar
				avatarUrl={url}
				className={className}
				engine={eng}
				size="16px"
			/>
		);
		agentIconCache.set(cacheKey, Icon);
	}
	// biome-ignore lint/style/noNonNullAssertion: just set above when missing
	return agentIconCache.get(cacheKey)!;
}

export interface AgentAvatarMember {
	avatarUrl?: string | null;
	engine?: string | null;
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
						i > 0 && overlap
					)}
					key={member.id}
					style={{ zIndex: shown.length - i }}
				>
					<AgentAvatar
						avatarUrl={member.avatarUrl}
						className="object-contain"
						engine={member.engine}
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
	// biome-ignore lint/style/noNonNullAssertion: just set above when missing
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
	if (!engineIconCache.has(cacheKey)) {
		const eng = engine;
		const Icon = ({ className }: { className?: string }) => (
			<AgentLogo className={className} engine={eng} size="16px" />
		);
		engineIconCache.set(cacheKey, Icon);
		return Icon;
	}
	return engineIconCache.get(cacheKey) as ComponentType<{ className?: string }>;
}
