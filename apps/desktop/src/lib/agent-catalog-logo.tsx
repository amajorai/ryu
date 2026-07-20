import { cn } from "@ryu/ui/lib/utils";
import {
	AgentLogo,
	engineForAgent,
	hasBrandedEngineLogo,
} from "@/src/lib/agent-logos.tsx";
import type { AgentCatalogEntry } from "@/src/lib/api/agents.ts";

type SvglSpec = string | { light: string; dark: string };

// Bundled brand marks (originally svgl.app) served from the desktop public dir.
const svglUrl = (slug: string) => `/assets/logos/${slug}.svg`;

/**
 * SVGL slug overrides for registry agents where svgl.app has a polished brand
 * mark. Curated agents with bundled local logos (claude, codex, gemini, pi,
 * ryu, openclaw, hermes) are handled by {@link AgentLogo} instead.
 */
const REGISTRY_SVGL: Record<string, SvglSpec> = {
	"amp-acp": "amp",
	cursor: { light: "cursor_light", dark: "cursor_dark" },
	"github-copilot-cli": { light: "copilot", dark: "copilot_dark" },
	"grok-build": { light: "grok-light", dark: "grok-dark" },
	junie: "jetbrains",
	kimi: "kimi-icon",
	"mistral-vibe": "mistral-ai_logo",
	opencode: { light: "opencode", dark: "opencode-dark" },
	"qwen-code": { light: "qwen_light", dark: "qwen_dark" },
};

function SvglLogo({
	spec,
	alt,
	className,
	size,
}: {
	spec: SvglSpec;
	alt: string;
	className?: string;
	size: string;
}) {
	const style = { width: size, height: size };
	if (typeof spec === "string") {
		return (
			// biome-ignore lint/performance/noImgElement lint/correctness/useImageSize: bundled logo asset
			<img
				alt={alt}
				className={cn(className, "shrink-0 object-contain")}
				draggable={false}
				src={svglUrl(spec)}
				style={style}
			/>
		);
	}
	return (
		<>
			{/* biome-ignore lint/performance/noImgElement lint/correctness/useImageSize: bundled logo asset */}
			<img
				alt={alt}
				className={cn(className, "block shrink-0 object-contain dark:hidden")}
				draggable={false}
				src={svglUrl(spec.light)}
				style={style}
			/>
			{/* biome-ignore lint/performance/noImgElement lint/correctness/useImageSize: bundled logo asset */}
			<img
				alt={alt}
				className={cn(className, "hidden shrink-0 object-contain dark:block")}
				draggable={false}
				src={svglUrl(spec.dark)}
				style={style}
			/>
		</>
	);
}

/** Logo for an agent catalog row: local engine assets → bundled SVGL → Ryu. */
export function AgentCatalogLogo({
	entry,
	className,
	size = "16px",
}: {
	entry: AgentCatalogEntry;
	className?: string;
	size?: string;
}) {
	const engine = engineForAgent({
		id: entry.id,
		engine: entry.engine,
		builtIn: true,
	});

	if (hasBrandedEngineLogo(engine)) {
		return <AgentLogo className={className} engine={engine} size={size} />;
	}

	const svgl = entry.registryId ? REGISTRY_SVGL[entry.registryId] : undefined;
	if (svgl) {
		return (
			<SvglLogo
				alt={entry.name}
				className={className}
				size={size}
				spec={svgl}
			/>
		);
	}

	// Uncurated registry agents (no bundled brand mark) fall back to the Ryu logo
	// rather than a remote icon fetch — Ryu is the car around any engine, so its
	// mark is the sensible offline default. (Backend `entry.iconUrl` / the ACP
	// icon CDN are intentionally not rendered: no logo image is fetched remotely.)
	return <AgentLogo className={className} engine={engine} size={size} />;
}
