// Human output for `ryu-cli connect`: every row and sentence renders in the
// CLI locale (labels are translated before they are padded) and numbers use
// the CLI's format locale. Table headers stay as `formatTable` prints them.
// `--json` output never comes through here. Split from `connect.ts`.

import {
	CLI_FORMAT_LOCALE,
	CLI_TRANSLATOR,
	type CliTranslator,
} from "../i18n/translate.ts";
import {
	type Balance,
	type DescribedTool,
	formatMicroUsd,
	type Health,
	type PlatformDetail,
	type PlatformIndex,
	type SearchResult,
	type ToolRequestReceipt,
} from "./connectClient.ts";
import { formatTable, truncate } from "./output.ts";

/** The translator and number locale one rendering uses (tests pin both). */
export interface ConnectText {
	formatLocale: string;
	tf: CliTranslator["tf"];
	tr: CliTranslator["tr"];
}

const DEFAULT_TEXT: ConnectText = {
	formatLocale: CLI_FORMAT_LOCALE,
	tf: CLI_TRANSLATOR.tf,
	tr: CLI_TRANSLATOR.tr,
};

interface CostLike {
	basis: string;
	free: boolean;
	usd: number | null;
}

/** One call's price from the catalog: `free`, `$0.005`, `$0.005+` (more meters), `usage`, `unverified`. */
export function formatCatalogCost(cost: CostLike | null): string {
	if (!cost) {
		return "-";
	}
	if (cost.free) {
		return "free";
	}
	if (cost.basis === "usage") {
		return "usage";
	}
	if (cost.usd === null) {
		return "unverified";
	}
	const text = formatMicroUsd(Math.round(cost.usd * 1_000_000));
	return cost.basis === "base_call" ? `${text}+` : text;
}

/** A tool's price per call: `$0.0004`, `~$0.0004` (estimated) or unmetered. */
export function priceText(
	price: DescribedTool["price"],
	text: ConnectText = DEFAULT_TEXT
): string {
	if (price.source === "unmetered") {
		return text.tr("unmetered");
	}
	const amount = formatMicroUsd(price.amountMicroUsd);
	return price.estimated ? `~${amount}` : amount;
}

function decimal(value: number, digits: number, locale: string): string {
	return new Intl.NumberFormat(locale, {
		maximumFractionDigits: digits,
		minimumFractionDigits: digits,
	}).format(value);
}

/** Label/value rows with the labels padded to one translated width. */
function alignedRows(rows: readonly (readonly [string, string])[]): string {
	const width = Math.max(9, ...rows.map(([name]) => name.length + 2));
	return rows
		.map(([name, value]) => `${name.padEnd(width)}${value}`)
		.join("\n");
}

export interface StatusView {
	balance: Balance | null;
	catalog: string | null;
	hasKey: boolean;
	health: Health;
	origin: string;
}

function balanceSummary(balance: Balance, text: ConnectText): string {
	if (!balance.billed) {
		return text.tr("not billed by Ryu");
	}
	const values = {
		available: formatMicroUsd(balance.availableMicroUsd),
		held: formatMicroUsd(balance.heldMicroUsd),
	};
	return balance.suspended
		? text.tf("{available} available, {held} held (suspended)", values)
		: text.tf("{available} available, {held} held", values);
}

/** `ryu-cli connect` with no subcommand: URL, health, key, balance, catalog. */
export function renderStatus(
	view: StatusView,
	text: ConnectText = DEFAULT_TEXT
): string {
	const { tr } = text;
	const rows: [string, string][] = [
		[
			tr("Connect"),
			`${view.origin}  ${view.health.service} ${view.health.version ?? ""}`.trim(),
		],
		[
			tr("Key"),
			view.hasKey
				? tr("set (RYU_CONNECT_KEY)")
				: tr("not set: export RYU_CONNECT_KEY"),
		],
	];
	if (view.balance) {
		rows.push([tr("Balance"), balanceSummary(view.balance, text)]);
	}
	rows.push([tr("Catalog"), view.catalog ?? tr("off")]);
	return alignedRows(rows);
}

/** `ryu-cli connect browse`: one row per platform. */
export function renderIndex(
	index: PlatformIndex,
	text: ConnectText = DEFAULT_TEXT
): string {
	if (index.platforms.length === 0) {
		return text.tr("The catalog lists no platforms yet.");
	}
	const rows = index.platforms.map((platform) => [
		platform.slug,
		String(platform.endpoints),
		String(platform.verified_endpoints),
		formatCatalogCost(platform.price_from),
		truncate(platform.providers.join(", "), 40),
	]);
	return formatTable(
		["PLATFORM", "ENDPOINTS", "VERIFIED", "FROM", "PROVIDERS"],
		rows
	);
}

/** `ryu-cli connect browse <platform>`: its endpoints with their prices. */
export function renderPlatform(
	detail: PlatformDetail,
	text: ConnectText = DEFAULT_TEXT
): string {
	const rows: string[][] = [];
	for (const domain of detail.domains) {
		for (const row of domain.rows) {
			for (const endpoint of row.endpoints) {
				rows.push([
					truncate(row.capability_name, 32),
					endpoint.id,
					endpoint.provider_display,
					formatCatalogCost(endpoint.cost),
					endpoint.verification.state,
					endpoint.id === row.cheapest_endpoint ? text.tr("cheapest") : "",
				]);
			}
		}
	}
	const table = formatTable(
		["CAPABILITY", "ENDPOINT", "PROVIDER", "PER CALL", "STATE", ""],
		rows
	);
	return `${detail.label} (${detail.slug})\n${table}`;
}

function renderMiss(result: SearchResult, text: ConnectText): string {
	const { tf, tr } = text;
	const lines = [tr("No tools matched.")];
	if (result.missedTerms?.length) {
		lines.push(
			tf("No tool matched: {terms}", { terms: result.missedTerms.join(", ") })
		);
	}
	if (result.didYouMean?.length) {
		lines.push(
			tf("Did you mean: {ids}", { ids: result.didYouMean.join(", ") })
		);
	}
	lines.push(
		tr("File it with: ryu-cli connect request <what the tool should do>")
	);
	return lines.join("\n");
}

/** `ryu-cli connect search`: the matches, or what to try instead. */
export function renderSearch(
	result: SearchResult,
	text: ConnectText = DEFAULT_TEXT
): string {
	if (result.data.length === 0) {
		return renderMiss(result, text);
	}
	const rows = result.data.map((tool) => [
		tool.id,
		tool.provider,
		tool.tier,
		priceText(tool.price, text),
		tool.catalog?.state ?? "",
		tool.score === undefined ? "" : decimal(tool.score, 2, text.formatLocale),
	]);
	const table = formatTable(
		["ID", "PROVIDER", "TIER", "PRICE", "CATALOG", "SCORE"],
		rows
	);
	return result.partial
		? `${table}\n${text.tr("Some tool sources did not answer; the list may be incomplete.")}`
		: table;
}

/** `ryu-cli connect describe`: price, catalog state, reliability, schema. */
export function renderDescribe(
	tool: DescribedTool,
	text: ConnectText = DEFAULT_TEXT
): string {
	const { tf, tr } = text;
	const reliability = tool.reliability;
	const lines = [
		`${tool.name} (${tool.id})`,
		tf("Provider   {provider} · {tier}{toolkit}", {
			provider: tool.provider,
			tier: tool.tier,
			toolkit: tool.toolkit ? ` · ${tool.toolkit}` : "",
		}),
		tf("Price      {price} per call ({source})", {
			price: priceText(tool.price, text),
			source: tool.price.source,
		}),
	];
	if (tool.catalog?.state) {
		lines.push(
			tf("Catalog    {state} ({source})", {
				state: tool.catalog.state,
				source: tool.catalog.source ?? "ryu",
			})
		);
	}
	if (reliability?.sufficient && typeof reliability.successRate === "number") {
		lines.push(
			tf("Reliable   {rate}% over 7 days, p50 {p50} ms, p95 {p95} ms", {
				rate: decimal(reliability.successRate * 100, 1, text.formatLocale),
				p50: String(reliability.p50Ms ?? "-"),
				p95: String(reliability.p95Ms ?? "-"),
			})
		);
	}
	lines.push("", tool.description, "", tr("Parameters:"));
	lines.push(JSON.stringify(tool.parameters ?? {}, null, 2));
	return lines.join("\n");
}

/** `ryu-cli connect request`: the receipt's status and id. */
export function renderReceipt(
	receipt: ToolRequestReceipt,
	text: ConnectText = DEFAULT_TEXT
): string {
	return receipt.id
		? text.tf("Request {status} ({id}).", {
				status: receipt.status,
				id: receipt.id,
			})
		: text.tf("Request {status}.", { status: receipt.status });
}

/** `ryu-cli connect balance`: what new calls can spend. */
export function renderBalance(
	current: Balance,
	text: ConnectText = DEFAULT_TEXT
): string {
	const { tf, tr } = text;
	if (!current.billed) {
		return tr(
			"This Connect is not billed by Ryu; calls are never refused for credit."
		);
	}
	const lines = [
		tf("Available  {amount}", {
			amount: formatMicroUsd(current.availableMicroUsd),
		}),
		tf("Held       {amount}", { amount: formatMicroUsd(current.heldMicroUsd) }),
		tf("Unsettled  {amount}", {
			amount: formatMicroUsd(current.unsettledMicroUsd),
		}),
	];
	if (current.suspended) {
		lines.push(tr("Suspended  yes: add credit to resume calls"));
	}
	if (current.topUpUrl) {
		lines.push(tf("Top up     {url}", { url: current.topUpUrl }));
	}
	return lines.join("\n");
}
