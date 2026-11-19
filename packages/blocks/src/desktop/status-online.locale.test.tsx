// The Fleet node badge and the "online" availability status are presence
// (ar "متصل", zh-CN "在线") and read through the keyed `status.online`. The
// bare catalog "Online" is an online event (ar "عبر الإنترنت", zh-CN "线上").
import { afterEach, expect, test } from "bun:test";
import { I18nRuntime } from "@ryu/i18n/core";
import { renderToStaticMarkup } from "react-dom/server";
// The provider registers its runtime here; a test registers its own.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../i18n/src/active-locale.ts";
import {
	AGENT_AVAILABILITY_OPTIONS,
	agentAvailabilityLabel,
} from "./agent-availability.tsx";
import { FleetView } from "./fleet.tsx";

let active: I18nRuntime | null = null;

function useLocale(packId: string): void {
	active = new I18nRuntime([], { initialPackId: packId });
	registerActiveI18nRuntime(active);
}

afterEach(() => {
	if (active) {
		unregisterActiveI18nRuntime(active);
		active = null;
	}
});

function fleetBadge(): string {
	const html = renderToStaticMarkup(
		<FleetView
			nodes={[
				{
					expanded: false,
					latencyMs: 40,
					name: "studio",
					online: true,
					services: null,
					statusKnown: true,
					url: "http://studio.local",
				},
			]}
		/>
	);
	return html.replace(/<[^>]+>/g, " ");
}

test("the Arabic fleet badge says the node is connected", () => {
	useLocale("official/ar");
	const text = fleetBadge();
	expect(text).toContain(" متصل ");
	expect(text).not.toContain("عبر الإنترنت");
});

test("the Chinese fleet badge says 在线", () => {
	useLocale("official/zh-cn");
	expect(fleetBadge()).toContain(" 在线 ");
});

test("the online availability status reads as presence", () => {
	useLocale("official/zh-cn");
	expect(agentAvailabilityLabel("online")).toBe("在线");
	expect(AGENT_AVAILABILITY_OPTIONS[0].label).toBe("在线");
	unregisterActiveI18nRuntime(active as I18nRuntime);
	useLocale("official/ar");
	expect(agentAvailabilityLabel("online")).toBe("متصل");
});

test("English keeps Online", () => {
	expect(fleetBadge()).toContain(" Online ");
	expect(agentAvailabilityLabel("online")).toBe("Online");
	expect(AGENT_AVAILABILITY_OPTIONS[0].label).toBe("Online");
});
