import { cn } from "@ryu/ui/lib/utils";

/** Landing card accents — one distinct hue per section card. */
export type LandingCardTone =
	| "orange"
	| "blue"
	| "pink"
	| "purple"
	| "yellow"
	| "green"
	| "teal";

interface LandingCardToneTokens {
	body: string;
	bullet: string;
	cta: string;
	ctaSecondary: string;
	eyebrow: string;
	marker: string;
	surface: string;
	title: string;
}

export const LANDING_CARD_TONES: Record<
	LandingCardTone,
	LandingCardToneTokens
> = {
	orange: {
		surface: "bg-[#ffe0b3]",
		eyebrow: "text-[#8a5318]/70",
		title: "text-[#5c3608]",
		body: "text-[#6d4210]/85",
		bullet: "text-[#5c3608]/90",
		marker: "text-[#6d4210]",
		cta: "border border-[#5c3608] bg-transparent text-[#5c3608] hover:bg-[#5c3608]/12 hover:text-[#5c3608]",
		ctaSecondary: "text-[#5c3608] hover:bg-[#5c3608]/10 hover:text-[#5c3608]",
	},
	blue: {
		surface: "bg-[#dbeafe]",
		eyebrow: "text-[#1e3a5f]/65",
		title: "text-[#1e3a5f]",
		body: "text-[#1e3a5f]/85",
		bullet: "text-[#1e3a5f]/90",
		marker: "text-[#1d4ed8]",
		cta: "border border-[#1e3a5f] bg-transparent text-[#1e3a5f] hover:bg-[#1e3a5f]/12 hover:text-[#1e3a5f]",
		ctaSecondary: "text-[#1e3a5f] hover:bg-[#1e3a5f]/10 hover:text-[#1e3a5f]",
	},
	pink: {
		surface: "bg-[#fce7f3]",
		eyebrow: "text-[#831843]/65",
		title: "text-[#831843]",
		body: "text-[#9d174d]/85",
		bullet: "text-[#831843]/90",
		marker: "text-[#be185d]",
		cta: "border border-[#831843] bg-transparent text-[#831843] hover:bg-[#831843]/12 hover:text-[#831843]",
		ctaSecondary: "text-[#831843] hover:bg-[#831843]/10 hover:text-[#831843]",
	},
	purple: {
		surface: "bg-[#ede9fe]",
		eyebrow: "text-[#4c1d95]/65",
		title: "text-[#4c1d95]",
		body: "text-[#5b21b6]/85",
		bullet: "text-[#4c1d95]/90",
		marker: "text-[#6d28d9]",
		cta: "border border-[#4c1d95] bg-transparent text-[#4c1d95] hover:bg-[#4c1d95]/12 hover:text-[#4c1d95]",
		ctaSecondary: "text-[#4c1d95] hover:bg-[#4c1d95]/10 hover:text-[#4c1d95]",
	},
	yellow: {
		surface: "bg-[#fef3c7]",
		eyebrow: "text-[#92400e]/65",
		title: "text-[#78350f]",
		body: "text-[#92400e]/85",
		bullet: "text-[#78350f]/90",
		marker: "text-[#b45309]",
		cta: "border border-[#78350f] bg-transparent text-[#78350f] hover:bg-[#78350f]/12 hover:text-[#78350f]",
		ctaSecondary: "text-[#78350f] hover:bg-[#78350f]/10 hover:text-[#78350f]",
	},
	green: {
		surface: "bg-[#dcfce7]",
		eyebrow: "text-[#166534]/65",
		title: "text-[#14532d]",
		body: "text-[#166534]/85",
		bullet: "text-[#14532d]/90",
		marker: "text-[#15803d]",
		cta: "border border-[#14532d] bg-transparent text-[#14532d] hover:bg-[#14532d]/12 hover:text-[#14532d]",
		ctaSecondary: "text-[#14532d] hover:bg-[#14532d]/10 hover:text-[#14532d]",
	},
	teal: {
		surface: "bg-[#ccfbf1]",
		eyebrow: "text-[#115e59]/65",
		title: "text-[#134e4a]",
		body: "text-[#115e59]/85",
		bullet: "text-[#134e4a]/90",
		marker: "text-[#0d9488]",
		cta: "border border-[#134e4a] bg-transparent text-[#134e4a] hover:bg-[#134e4a]/12 hover:text-[#134e4a]",
		ctaSecondary: "text-[#134e4a] hover:bg-[#134e4a]/10 hover:text-[#134e4a]",
	},
};

export function landingCardSurfaceClass(tone: LandingCardTone) {
	return cn("h-full rounded-2xl p-4 md:p-5", LANDING_CARD_TONES[tone].surface);
}

export const landingMutedCardSurfaceClass =
	"h-full rounded-2xl bg-muted/40 p-4 md:p-5";

/** Muted surface cards on the landing page (no tone). */
export const landingSurfaceCardClass =
	"rounded-2xl bg-muted/50 p-4 backdrop-blur-sm transition-colors duration-200 hover:bg-muted/70";

export const landingSurfaceCardFlexClass =
	"flex h-full flex-col gap-3 rounded-2xl bg-muted/50 p-4 backdrop-blur-sm transition-colors duration-200 hover:bg-muted/70";

export const landingSurfaceCardXlClass =
	"rounded-xl bg-muted/50 p-4 backdrop-blur-sm transition-colors duration-200 hover:bg-muted/70";

export const landingSurfaceCardFlexXlClass =
	"flex h-full flex-col justify-between gap-4 rounded-xl bg-muted/50 p-4 backdrop-blur-sm transition-colors duration-200 hover:bg-muted/70";
