import { describe, expect, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";
import {
	type ConnectText,
	priceText,
	renderBalance,
	renderDescribe,
	renderIndex,
	renderPlatform,
	renderReceipt,
	renderSearch,
	renderStatus,
} from "./connect-render.ts";
import type { Balance, DescribedTool } from "./connectClient.ts";

const german = createCliTranslator("de", {
	Balance: "Guthaben",
	Catalog: "Katalog",
	Key: "Schlüssel",
	"{available} available, {held} held":
		"{available} verfügbar, {held} reserviert",
	"set (RYU_CONNECT_KEY)": "gesetzt (RYU_CONNECT_KEY)",
	off: "aus",
	"The catalog lists no platforms yet.":
		"Der Katalog listet noch keine Plattformen.",
	cheapest: "am günstigsten",
	"No tools matched.": "Keine Tools gefunden.",
	"File it with: ryu-cli connect request <what the tool should do>":
		"Melden Sie es mit: ryu-cli connect request <was das Tool tun soll>",
	"Some tool sources did not answer; the list may be incomplete.":
		"Einige Toolquellen haben nicht geantwortet; die Liste ist eventuell unvollständig.",
	unmetered: "ohne Abrechnung",
	"Parameters:": "Parameter:",
	"Reliable {rate}% over 7 days, p50 {p50} ms, p95 {p95} ms":
		"Zuverlässig {rate} % über 7 Tage, p50 {p50} ms, p95 {p95} ms",
	"Request {status} ({id}).": "Anfrage {status} ({id}).",
	"This Connect is not billed by Ryu; calls are never refused for credit.":
		"Dieses Connect wird nicht von Ryu abgerechnet.",
	"Suspended yes: add credit to resume calls":
		"Gesperrt ja: Laden Sie Guthaben auf",
});
const text: ConnectText = {
	formatLocale: "de-DE",
	tf: german.tf,
	tr: german.tr,
};

const balance: Balance = {
	object: "balance",
	availableMicroUsd: 12_500_000,
	billed: true,
	heldMicroUsd: 400,
	headroomMicroUsd: null,
	suspended: true,
	topUpUrl: null,
	unsettledMicroUsd: 0,
	unsettledSince: null,
};

const tool: DescribedTool = {
	id: "composio.X",
	name: "X",
	description: "Does X.",
	kind: "composio",
	provider: "ryu",
	tier: "native",
	price: {
		amountMicroUsd: 0,
		estimated: false,
		per: "call",
		source: "unmetered",
	},
	score: 3.25,
	reliability: { sufficient: true, successRate: 0.995, p50Ms: 1, p95Ms: 2 },
	parameters: {},
};

describe("connect rendering", () => {
	test("status labels are translated before they are padded", () => {
		const out = renderStatus(
			{
				balance: { ...balance, suspended: false },
				catalog: null,
				hasKey: true,
				health: { service: "ryu-connect", version: "0.4.0" },
				origin: "https://c.example",
			},
			text
		);
		expect(out).toContain("Schlüssel  gesetzt (RYU_CONNECT_KEY)");
		expect(out).toContain("Guthaben   $12.5 verfügbar, $0.0004 reserviert");
		expect(out).toContain("Katalog    aus");
	});

	test("browse, search and describe copy renders in the locale", () => {
		expect(
			renderIndex(
				{ type: "ryu.tool_catalog.platforms", generated_at: "", platforms: [] },
				text
			)
		).toBe("Der Katalog listet noch keine Plattformen.");
		const platform = renderPlatform(
			{
				type: "ryu.tool_catalog.platform",
				slug: "web",
				label: "Web",
				endpoints: 1,
				verified_endpoints: 1,
				capabilities: 1,
				providers: [],
				price_from: null,
				source: "ryu",
				domains: [
					{
						id: "d",
						label: "D",
						rows: [
							{
								capability: "c",
								capability_name: "Search",
								cheapest_endpoint: "e",
								endpoints: [
									{
										id: "e",
										name: "e",
										provider: "p",
										provider_display: "P",
										source: "ryu",
										cost: null,
										verification: { state: "verified" },
										platform_eligible: true,
									},
								],
							},
						],
					},
				],
			},
			text
		);
		expect(platform).toContain("am günstigsten");
		const miss = renderSearch({ object: "list", data: [] }, text);
		expect(miss).toContain("Keine Tools gefunden.");
		expect(miss).toContain("Melden Sie es mit");
		const found = renderSearch(
			{ object: "list", data: [tool], partial: true },
			text
		);
		expect(found).toContain("ohne Abrechnung");
		expect(found).toContain("3,25");
		expect(found).toContain("Einige Toolquellen");
		const described = renderDescribe(tool, text);
		expect(described).toContain("Zuverlässig 99,5 % über 7 Tage");
		expect(described).toContain("Parameter:");
	});

	test("unmetered prices, receipts and balances are translated", () => {
		expect(priceText(tool.price, text)).toBe("ohne Abrechnung");
		expect(
			renderReceipt({ ok: true, status: "received", id: "t1" }, text)
		).toBe("Anfrage received (t1).");
		expect(renderBalance({ ...balance, billed: false }, text)).toBe(
			"Dieses Connect wird nicht von Ryu abgerechnet."
		);
		expect(renderBalance(balance, text)).toContain(
			"Gesperrt ja: Laden Sie Guthaben auf"
		);
	});
});
