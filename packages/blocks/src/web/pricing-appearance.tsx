"use client";

import { createContext, type ReactNode, useContext } from "react";

/** Fill for the plan cards' filled CTAs. The desktop paywall and portal keep
 * the themed `default`; the public pricing grids switch to neutral `mono`. */
export type PricingCtaVariant = "default" | "mono";

const PricingCtaVariantContext = createContext<PricingCtaVariant>("default");

/** Sets the fill of every filled plan CTA rendered inside it. Public marketing
 * pages wrap standalone plan cards in `value="mono"`; the grids already do. */
export function PricingCtaVariantProvider({
	children,
	value,
}: {
	children: ReactNode;
	value: PricingCtaVariant;
}) {
	return (
		<PricingCtaVariantContext.Provider value={value}>
			{children}
		</PricingCtaVariantContext.Provider>
	);
}

export function usePricingCtaVariant(): PricingCtaVariant {
	return useContext(PricingCtaVariantContext);
}

/**
 * Card chrome for the plan cards. `default` is what the desktop paywall, the
 * Teams billing tab and signed-in org billing render, and must not change.
 * `public` is the `/pricing` page treatment: the same tier badges and gradient
 * ring as product surfaces, with pill CTAs and 14px helper text.
 */
export type PricingAppearance = "default" | "public";

const PricingAppearanceContext = createContext<PricingAppearance>("default");

/** Sets the card chrome of every plan card rendered inside it. Only the public
 * `/pricing` page passes `appearance="public"`. */
export function PricingAppearanceProvider({
	appearance,
	children,
}: {
	appearance: PricingAppearance;
	children: ReactNode;
}) {
	return (
		<PricingAppearanceContext.Provider value={appearance}>
			{children}
		</PricingAppearanceContext.Provider>
	);
}

export function useIsPublicPricing(): boolean {
	return useContext(PricingAppearanceContext) === "public";
}

/** Small helper copy: 12px in product surfaces, 14px on the public page. */
export function useHelperTextSize(): "text-sm" | "text-xs" {
	return useIsPublicPricing() ? "text-sm" : "text-xs";
}

/** Public CTAs are large mono pills; product surfaces keep the default shape. */
const PUBLIC_CTA_SHAPE = "corner-round rounded-full";

export function usePlanCtaShape(): { className: string; size?: "lg" } {
	// A disabled public CTA (terms not yet accepted) stays the same black/white
	// pill, just faded, rather than reading as a separate grey button.
	return useIsPublicPricing()
		? {
				className: `w-full ${PUBLIC_CTA_SHAPE} disabled:opacity-40`,
				size: "lg",
			}
		: { className: "w-full" };
}
