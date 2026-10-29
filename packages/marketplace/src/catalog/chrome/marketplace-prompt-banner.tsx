"use client";

import { ditherAvatarHue } from "@ryu/ui/components/dither-kit/avatar.tsx";
import { ShaderBackground } from "@ryu/ui/components/motion/shader-background.tsx";
import {
	hueHex,
	WARP_BASE_DARK,
	WARP_BASE_LIGHT,
	WARP_DISTORTION,
	WARP_HUE_SPREAD,
	WARP_SCALE,
	WARP_SOFTNESS,
	WARP_SPEED,
	WARP_SWIRL,
} from "@ryu/ui/components/pass-card-shell.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { ArrowRight } from "lucide-react";
import { useMemo } from "react";
import { safeCssBackground } from "../safe-url.ts";
import type { CatalogBanner } from "../types.ts";

/** CSS colour forms accepted by the Paper shader's colour parser. A banner may
 * still carry a richer CSS background for the detail hero; that is deliberately
 * not passed as a shader stop because `linear-gradient(...)` is not a colour. */
const SHADER_COLOR_RE =
	/^(?:#|rgb\(|rgba\(|hsl\(|hsla\(|hwb\(|lab\(|lch\(|oklab\(|oklch\(|color\()/i;

function shaderColor(value: string | undefined): string | null {
	const safe = safeCssBackground(value);
	return safe && SHADER_COLOR_RE.test(safe) ? safe : null;
}

/**
 * Resolve the prompt banner palette from the same warp field used by the
 * waitlist's 3D pass. `banner.colors` (or a simple `banner.background`) is an
 * explicit manifest override; otherwise the listing id supplies a stable hue,
 * so the fallback is deterministic rather than changing on every render.
 */
export function resolveMarketplacePromptColors(
	seed: string,
	banner: CatalogBanner | null | undefined,
	isDark: boolean
): string[] {
	const declared = (banner?.colors ?? [])
		.map((color) => shaderColor(color))
		.filter((color): color is string => color !== null)
		.slice(0, 4);
	const background = shaderColor(banner?.background);
	if (declared.length === 0 && background) {
		declared.push(background);
	}

	const first = declared[0];
	if (first) {
		const second = declared[1] ?? first;
		return [first, second, first, declared[2] ?? second];
	}

	const base = isDark ? WARP_BASE_DARK : WARP_BASE_LIGHT;
	const hue = ditherAvatarHue(seed);
	return [base, hueHex(hue), base, hueHex(hue + WARP_HUE_SPREAD)];
}

/** A small, prompt-first banner for the Marketplace preview. */
export function MarketplacePromptBanner({
	banner,
	isDark,
	name,
	onPrompt,
	prompts,
	seed,
}: {
	banner?: CatalogBanner | null;
	isDark: boolean;
	name: string;
	onPrompt: (prompt: string) => void;
	prompts: string[];
	seed: string;
}) {
	const colors = useMemo(
		() => resolveMarketplacePromptColors(seed, banner, isDark),
		[banner, isDark, seed]
	);
	const visiblePrompts = prompts.slice(0, 3);
	const foreground = isDark ? "text-white" : "text-black";
	const rowClass = isDark
		? "bg-black/65 text-white hover:bg-black/80"
		: "bg-white/75 text-black hover:bg-white/90";

	return (
		<section
			className={cn(
				"relative isolate overflow-hidden rounded-2xl px-3 py-3 sm:px-4 sm:py-4",
				foreground
			)}
			data-palette={colors.join("|")}
			data-testid="marketplace-prompt-banner"
		>
			<ShaderBackground
				className="absolute inset-0 -z-10 size-full"
				colors={colors}
				distortion={WARP_DISTORTION}
				scale={WARP_SCALE}
				softness={WARP_SOFTNESS}
				speed={WARP_SPEED}
				swirl={WARP_SWIRL}
				variant="warp"
			/>
			<div
				aria-hidden="true"
				className={cn(
					"absolute inset-0 -z-10",
					isDark ? "bg-black/10" : "bg-white/10"
				)}
			/>
			<div className="flex flex-col items-center gap-2">
				{visiblePrompts.map((prompt) => (
					<button
						className={cn(
							"group flex w-[min(34rem,100%)] min-w-0 items-center gap-2 rounded-xl px-3 py-2 text-left text-sm backdrop-blur-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80",
							rowClass
						)}
						key={prompt}
						onClick={() => onPrompt(prompt)}
						title="Copy prompt"
						type="button"
					>
						<span className="min-w-0 max-w-[10rem] shrink-0 truncate rounded-full bg-black/5 px-2 py-1 font-medium text-primary text-xs dark:bg-white/10">
							@{name}
						</span>
						<span className="min-w-0 flex-1 truncate" title={prompt}>
							{prompt}
						</span>
						<span
							aria-hidden="true"
							className="flex size-6 shrink-0 items-center justify-center rounded-full bg-white/15 transition-transform motion-safe:group-hover:translate-x-0.5"
						>
							<ArrowRight className="size-3.5" />
						</span>
					</button>
				))}
			</div>
		</section>
	);
}
