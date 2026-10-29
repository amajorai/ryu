// apps/desktop/src/lib/integration-price.ts
//
// One Integrations Store option's price as display text. A Ryu catalog row
// says what its figure covers (`basis`): a base price lists the meters billed
// on top of it, so it never reads as the whole per-call price.

import type { IntegrationPrice } from "./api/integrations.ts";

function meterLabel(meter: string): string {
	return meter.replaceAll("_", " ");
}

export function providerOptionPrice(price: IntegrationPrice | null): string {
	if (!price) {
		return "Price not published";
	}
	if (price.basis === "usage" && price.meteredBy.length > 0) {
		return `Priced by ${price.meteredBy.map(meterLabel).join(", ")}`;
	}
	// A base price says what is billed on top of it.
	const extra =
		price.basis === "base_call" && price.meteredBy.length > 0
			? ` + ${price.meteredBy.map(meterLabel).join(", ")}`
			: "";
	if (price.usd != null && Number.isFinite(price.usd)) {
		if (price.usd === 0 && !extra) {
			return "Free";
		}
		const amount = price.usd.toLocaleString(undefined, {
			maximumFractionDigits: 6,
			minimumFractionDigits: 0,
		});
		return `$${amount}${price.unit ? ` / ${price.unit}` : ""}${extra}`;
	}
	if (price.value != null) {
		const currency = price.currency ?? "credits";
		return `${price.value} ${currency}${price.unit ? ` / ${price.unit}` : ""}${extra}`;
	}
	return "Pricing varies";
}
