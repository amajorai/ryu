import type { ReactNode } from "react";

/** A dollar amount field for a row's `actions`: the `$` prefix plus its input. */
export function DollarField({ children }: { children: ReactNode }) {
	return (
		<span className="flex items-center gap-2">
			<span className="text-muted-foreground text-sm">$</span>
			{children}
		</span>
	);
}

/** Micro-USD per US dollar (the wallet + budget base unit). */
export const MICRO_USD_PER_DOLLAR = 1_000_000;

export const centsToDollarText = (cents: number): string => String(cents / 100);

export const dollarTextToCents = (text: string): number => {
	const value = Number.parseFloat(text);
	return Number.isFinite(value) ? Math.round(value * 100) : 0;
};

export const microToDollarText = (micro: number): string =>
	String(micro / MICRO_USD_PER_DOLLAR);

export const dollarTextToMicro = (text: string): number => {
	const value = Number.parseFloat(text);
	return Number.isFinite(value) ? Math.round(value * MICRO_USD_PER_DOLLAR) : 0;
};

export const errorText = <TError,>(e: TError): string =>
	e instanceof Error ? e.message : "Something went wrong. Please try again.";
