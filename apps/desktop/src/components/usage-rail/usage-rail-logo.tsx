"use client";

// The mark in the middle of a usage ring and at the head of its card: the
// provider's brand mark, the agent's avatar, or the first letter of the name
// for a pool that mixes providers or a provider with no bundled mark.

import { cn } from "@ryu/ui/lib/utils.ts";
import { AgentAvatar } from "@/src/lib/agent-logos.tsx";
import {
	ProviderBrandLogo,
	svglForProvider,
} from "@/src/lib/provider-brand.tsx";
import type { RailLogo } from "@/src/lib/usage-rail/usage-rail-sources.ts";

/** The two sizes a mark is drawn at: inside a ring, and at the head of a card. */
export type RailLogoSize = 14 | 16;

const WHITESPACE = /\s+/;

/**
 * The letter of a provider with no bundled mark. Its key reads "<id> <label>"
 * and an id holds no space, so the word after the id starts the label. A key
 * with no label gives the letter of the id.
 */
function providerInitial(key: string): string {
	const [id = "", label] = key.trim().split(WHITESPACE);
	return Array.from(label ?? id).at(0) ?? "";
}

export function RailLogoMark({
	className,
	logo,
	size,
}: {
	className?: string;
	logo: RailLogo;
	size: RailLogoSize;
}) {
	if (logo.kind === "agent") {
		return (
			<AgentAvatar
				avatarUrl={logo.avatarUrl}
				className={cn("shrink-0 object-contain", className)}
				engine={logo.engine}
				glyph={logo.glyph}
				presentation="compact"
				size={`${size}px`}
			/>
		);
	}
	if (logo.kind === "provider" && svglForProvider(logo.key)) {
		return (
			<ProviderBrandLogo
				className={cn("shrink-0", className)}
				providerKey={logo.key}
				size={size}
			/>
		);
	}
	const text = logo.kind === "initial" ? logo.text : providerInitial(logo.key);
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex shrink-0 items-center justify-center font-semibold text-muted-foreground uppercase leading-none",
				size === 16 ? "size-4 text-xs" : "size-3.5 text-[0.6875rem]",
				className
			)}
			data-ryu-i18n="off"
		>
			{text || "?"}
		</span>
	);
}
