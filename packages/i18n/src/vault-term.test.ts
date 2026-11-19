import { describe, expect, test } from "bun:test";

// One word for Ryu's Vault per locale. The Vault page label, the mobile
// broker-proposal pointers ("…on the desktop, in Vault.") and every generic
// vault sentence use that word, so a reader never meets two names for the
// same page. Product and protocol names stay as they are: HashiCorp Vault,
// Identity Vault, Secret Vault and the `VAULT_*` environment variables.

const VAULT_LABEL: Readonly<Record<string, string>> = {
	ar: "الخزنة",
	de: "Tresor",
	es: "Bóveda",
	fr: "Coffre-fort",
	hi: "वॉल्ट",
	it: "Cassaforte",
	ja: "保管庫",
	ko: "보관함",
	"pt-BR": "Cofre",
	ru: "Хранилище",
	"zh-CN": "保险库",
};

// Words a translation must not use for a generic vault. A Latin "Vault" left
// in a sentence is untranslated, so it is off-term in every locale.
const OFF_TERM: Readonly<Record<string, RegExp>> = {
	ar: /مخزن|خزينة|Vault/,
	de: /Vault/,
	es: /[Aa]lmac[eé]n|Vault/,
	fr: /[Cc]offres?(?![-‑]forts?)\b|Vault/,
	hi: /तिजोरी|Vault/,
	it: /[Cc]aveau|Vault/,
	ja: /ボールト|ヴォールト|金庫|Vault/,
	ko: /보관소|볼트|금고|Vault/,
	"pt-BR": /Vault/,
	ru: /[Сс]ейф|Vault/,
	"zh-CN": /保管库|金库|Vault/,
};

// Names keep their own wording, so they are removed before the check.
const SOURCE_NAMES =
	/HashiCorp Vault|Identity Vault|Secret Vault|Vault-compatible|Vault-style|Vault\/OpenBao|\w*VAULT_\w*/gi;
const TRANSLATED_NAMES =
	/HashiCorp Vault|Identity[- ]Vault|Secret[- ]Vault|シークレットボールト|시크릿 볼트|Vault\/OpenBao|\w*VAULT_\w*/g;
const GENERIC_VAULT = /\bvaults?\b/i;

// What a sentence that names the Vault page must contain, case-insensitively;
// a stem where the word inflects (ar خزنتك, ru хранилища).
const VAULT_STEM: Readonly<Record<string, string>> = {
	ar: "خزن",
	de: "tresor",
	es: "bóveda",
	fr: "coffre-fort",
	hi: "वॉल्ट",
	it: "cassaforte",
	ja: "保管庫",
	ko: "보관함",
	"pt-BR": "cofre",
	ru: "хранилищ",
	"zh-CN": "保险库",
};

const BROKER_PROPOSAL_POINTERS = [
	"Approving lets the agent use this credential once. Longer access is granted on the desktop, in Vault.",
	"Values for requested credentials are added on the desktop, in Vault.",
] as const;

const CLI_BROKER_TAB =
	"A person approves it in the Vault page's Broker tab. Check again with 'ryu-cli secrets broker proposal {id}'.";

// The Vault page's "Broker" tab keeps the English loanword in these locales.
const BROKER_LOANWORD_LOCALES = ["de", "es", "fr", "it", "pt-BR"] as const;

const vaultTermViolations = (
	locale: string,
	catalog: Record<string, unknown>
): string[] => {
	const offTerm = OFF_TERM[locale];
	if (!offTerm) {
		return [`no vault glossary for ${locale}`];
	}
	const violations: string[] = [];
	for (const [source, value] of Object.entries(catalog)) {
		if (typeof value !== "string") {
			continue;
		}
		if (!GENERIC_VAULT.test(source.replace(SOURCE_NAMES, ""))) {
			continue;
		}
		if (offTerm.test(value.replace(TRANSLATED_NAMES, ""))) {
			violations.push(`${source} -> ${value}`);
		}
	}
	return violations;
};

const LOCALES_DIR = new URL("../locales/", import.meta.url);

const readCatalog = async (path: string) =>
	(await Bun.file(new URL(path, LOCALES_DIR)).json()) as Record<
		string,
		unknown
	>;

const LOCALES = Object.keys(VAULT_LABEL);

describe("vault term guard", () => {
	test("off-term vault words are flagged per locale", () => {
		expect(
			vaultTermViolations("ja", {
				"Delete vault entry": "ボールトのエントリを削除",
				"Open Vault": "Vault を開く",
			})
		).toEqual([
			"Delete vault entry -> ボールトのエントリを削除",
			"Open Vault -> Vault を開く",
		]);
		expect(
			vaultTermViolations("ko", {
				"Seal vault": "볼트 봉인",
				"The vault is sealed": "보관소가 봉인되어 있습니다",
			})
		).toEqual([
			"Seal vault -> 볼트 봉인",
			"The vault is sealed -> 보관소가 봉인되어 있습니다",
		]);
		expect(
			vaultTermViolations("fr", {
				"The encrypted vault is unavailable.":
					"Le coffre chiffré n’est pas disponible.",
			})
		).toEqual([
			"The encrypted vault is unavailable. -> Le coffre chiffré n’est pas disponible.",
		]);
	});

	test("the locale vault word and product names pass", () => {
		expect(
			vaultTermViolations("ja", {
				"Delete vault entry": "保管庫のエントリを削除",
				"Secret Vault": "シークレットボールト",
				"Vault/OpenBao CLIs work too (Ryu serves the /v1 API): export VAULT_ADDR={address} VAULT_TOKEN=<this token>":
					"Vault/OpenBao の CLI も使用できます（Ryu は /v1 API を提供します）: export VAULT_ADDR={address} VAULT_TOKEN=<このトークン>",
			})
		).toEqual([]);
		expect(
			vaultTermViolations("fr", {
				"Import {count, plural, one {# item} other {# items}} and move credentials into the Secret Vault?":
					"Importer {count, plural, one {# élément} other {# éléments}} et déplacer les identifiants vers le Secret Vault ?",
				"The encrypted vault is unavailable.":
					"Le coffre-fort chiffré n’est pas disponible.",
			})
		).toEqual([]);
	});
});

describe("catalogs use one vault term per locale", () => {
	test.each(LOCALES)("the root %s catalog", async (locale) => {
		const catalog = await readCatalog(`${locale}.json`);
		expect(catalog.Vault).toBe(VAULT_LABEL[locale]);
		expect(vaultTermViolations(locale, catalog)).toEqual([]);
	});

	test.each(
		LOCALES
	)("the %s native subset points to the Vault page by its label", async (locale) => {
		const catalog = await readCatalog(`native/${locale}.json`);
		const stem = VAULT_STEM[locale] ?? "";
		for (const source of BROKER_PROPOSAL_POINTERS) {
			const value = catalog[source];
			expect(typeof value).toBe("string");
			expect(String(value).toLocaleLowerCase(locale)).toContain(stem);
		}
		expect(vaultTermViolations(locale, catalog)).toEqual([]);
	});

	test.each(
		LOCALES
	)("the %s CLI broker hint names the Vault page", async (locale) => {
		const catalog = await readCatalog(`cli/${locale}.json`);
		const stem = VAULT_STEM[locale] ?? "";
		expect(String(catalog[CLI_BROKER_TAB]).toLocaleLowerCase(locale)).toContain(
			stem
		);
		expect(vaultTermViolations(locale, catalog)).toEqual([]);
	});

	test.each(
		BROKER_LOANWORD_LOCALES
	)("the %s Broker tab keeps the loanword", async (locale) => {
		const root = await readCatalog(`${locale}.json`);
		const cli = await readCatalog(`cli/${locale}.json`);
		expect(root.Broker).toBe("Broker");
		expect(String(cli[CLI_BROKER_TAB])).toContain("Broker");
	});
});
