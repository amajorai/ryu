import { PrismGradient } from "@ryu/ui/components/motion/prism-gradient.tsx";
import { useTheme } from "next-themes";
import type { ReactNode } from "react";
import { TrianglePrism } from "@/src/components/onboarding/TrianglePrism.tsx";
import { useMotionAllowed } from "@/src/hooks/useSeasonalEffects.ts";

// Onboarding cards sit directly on the backdrop: strip the fill from every
// `Card` and `SettingsCard` inside it and keep only a hairline edge.
const TRANSPARENT_CARDS =
	"[&_[data-slot=card]]:bg-transparent [&_[data-slot=card]]:shadow-none [&_[data-slot=settings-card]]:border [&_[data-slot=settings-card]]:border-border/60 [&_[data-slot=settings-card]]:bg-transparent";

export function OnboardingPrismBackground({
	children,
}: {
	children: ReactNode;
}) {
	const motionAllowed = useMotionAllowed();
	const { resolvedTheme } = useTheme();
	const dark = resolvedTheme === "dark";

	return (
		<div className="relative isolate size-full overflow-hidden bg-background">
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
			<div className={`relative z-10 size-full ${TRANSPARENT_CARDS}`}>
				{children}
			</div>
		</div>
	);
}
