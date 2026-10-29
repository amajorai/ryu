import {
	BarChart3,
	BookOpen,
	Boxes,
	Brain,
	Briefcase,
	Bug,
	Calculator,
	CalendarClock,
	Code,
	FileEdit,
	FileText,
	GraduationCap,
	Headphones,
	HeartHandshake,
	HeartPulse,
	Home,
	Landmark,
	Languages,
	LifeBuoy,
	type LucideIcon,
	Megaphone,
	Microscope,
	Palette,
	Pencil,
	PenLine,
	Receipt,
	Rocket,
	Scale,
	Server,
	Settings,
	ShieldCheck,
	ShoppingCart,
	Sparkles,
	TrendingUp,
	Umbrella,
	UserPlus,
	Users,
} from "lucide-react";
import type { SolutionUseCase } from "./data/solutions.ts";
import { withBentoFigures } from "./iso/figures/bento/with-bento-figures.tsx";
import { BentoGrid } from "./sections.tsx";

/* ------------------------------------------------------------------ */
/* Icon resolver (keeps the JSON data layer icon-free)                */
/* ------------------------------------------------------------------ */

// Resolve authored names only; prototype member names use the normal fallback.
const ICONS = new Map<string, LucideIcon>(
	Object.entries({
		BarChart3,
		BookOpen,
		Boxes,
		Brain,
		Briefcase,
		Bug,
		Calculator,
		CalendarClock,
		Code,
		FileEdit,
		FileText,
		GraduationCap,
		Headphones,
		HeartHandshake,
		HeartPulse,
		Home,
		Landmark,
		Languages,
		LifeBuoy,
		Megaphone,
		Microscope,
		Palette,
		Pencil,
		PenLine,
		Receipt,
		Rocket,
		Scale,
		Server,
		Settings,
		ShieldCheck,
		ShoppingCart,
		TrendingUp,
		Umbrella,
		UserPlus,
		Users,
	} satisfies Record<string, LucideIcon>)
);

export function iconFor(key: string): LucideIcon {
	return ICONS.get(key) ?? Sparkles;
}

/* ------------------------------------------------------------------ */
/* Use cases (what a role does with Ryu)                              */
/* ------------------------------------------------------------------ */

/** A role's use cases, rendered as the shared capability list. */
export function UseCases({
	items,
	slug,
}: {
	items: SolutionUseCase[];
	/** The role's slug: its use cases are drawn from the `for/<slug>` group. */
	slug?: string;
}) {
	return (
		<BentoGrid items={slug ? withBentoFigures(`for/${slug}`, items) : items} />
	);
}

/**
 * @deprecated Solution pages no longer render example prompts. Kept only so the
 * apps/web re-export in components/solutions/sections.tsx compiles; remove both together.
 */
export function ExamplePrompts(_props: { items: string[] }) {
	return null;
}
