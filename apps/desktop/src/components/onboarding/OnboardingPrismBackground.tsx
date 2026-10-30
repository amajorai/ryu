import { PrismGradient } from "@ryu/ui/components/motion/prism-gradient.tsx";
import { useTheme } from "next-themes";
import type { ReactNode } from "react";
import { TrianglePrism } from "@/src/components/onboarding/TrianglePrism.tsx";
import { useMotionAllowed } from "@/src/hooks/useSeasonalEffects.ts";

/**
 * The welcome's prism backdrop as a bare, absolutely positioned layer. The
 * onboarding page lazy-loads it behind the welcome only; setup and form steps
 * sit on the plain page background.
 */
export function OnboardingPrismLayer() {
	const motionAllowed = useMotionAllowed();
	const { resolvedTheme } = useTheme();
	const dark = resolvedTheme === "dark";

	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute inset-0 z-0 opacity-90"
			data-testid="onboarding-prism-background"
			data-variant={dark ? "triangle-prism" : "prism-gradient"}
		>
			{dark ? (
				<TrianglePrism animate={motionAllowed} />
			) : (
				<PrismGradient
					className="size-full"
					noise={{ opacity: 0.18, scale: 0.8 }}
					speed={motionAllowed ? 0.2 : 0}
				/>
			)}
		</div>
	);
}

export function OnboardingPrismBackground({
	children,
}: {
	children: ReactNode;
}) {
	return (
		<div className="relative isolate size-full overflow-hidden bg-background">
			<OnboardingPrismLayer />
			<div className="relative z-10 size-full">{children}</div>
		</div>
	);
}
