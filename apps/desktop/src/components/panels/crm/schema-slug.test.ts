import { describe, expect, test } from "bun:test";
import { defaultPlural, schemaSlug, slugify } from "./schema-slug.ts";

/** `is_valid_slug` in crm/backend/src/models.rs. */
const STORE_SLUG = /^[a-z][a-z0-9_]{0,63}$/;

describe("schemaSlug", () => {
	test("a Latin name keeps its readable slug", () => {
		expect(schemaSlug("Investor", "object")).toBe("investor");
		expect(schemaSlug("Annual contract value", "field")).toBe(
			"annual_contract_value"
		);
	});

	test("a ja, ru or ar name gets a slug the store accepts", () => {
		for (const name of ["投資家", "Инвестор", "مستثمر", "  顧客  "]) {
			const slug = schemaSlug(name, "object");
			expect(slug).toMatch(STORE_SLUG);
			expect(slug.startsWith("object_")).toBe(true);
		}
		expect(schemaSlug("年間契約額", "field")).toMatch(/^field_[a-z0-9]+$/);
	});

	test("the fallback slug is stable per name and differs between names", () => {
		expect(schemaSlug("投資家", "object")).toBe(schemaSlug("投資家", "object"));
		expect(schemaSlug("投資家", "object")).not.toBe(
			schemaSlug("顧客", "object")
		);
	});

	test("a name with no letters or digits has no slug", () => {
		expect(schemaSlug("", "object")).toBe("");
		expect(schemaSlug("  !? ", "field")).toBe("");
	});

	test("a digit-first or reserved name is made valid", () => {
		expect(schemaSlug("2nd phone", "field")).toBe("field_2nd_phone");
		expect(schemaSlug("Title", "field")).toBe("title_field");
		expect(schemaSlug("ID", "object")).toBe("id_object");
		for (const name of ["2nd phone", "Title", "ID", "Created at"]) {
			expect(schemaSlug(name, "field")).toMatch(STORE_SLUG);
		}
	});

	test("option ids keep the plain ASCII slug, empty for other scripts", () => {
		expect(slugify("In progress")).toBe("in_progress");
		expect(slugify("進行中")).toBe("");
	});

	test("the mirrored rule is the store's", async () => {
		const models = await Bun.file(
			`${import.meta.dir}/../../../../../../apps-store/crm/backend/src/models.rs`
		).text();
		expect(models).toContain("if !first.is_ascii_lowercase() {");
		expect(models).toContain(
			"chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')"
		);
		expect(models).toContain("pub const RESERVED_SLUGS: [&str; 8]");
	});
});

describe("defaultPlural", () => {
	test("an English s is added only to a Latin-script name", () => {
		expect(defaultPlural("Investor")).toBe("Investors");
		expect(defaultPlural(" Partner ")).toBe("Partners");
		expect(defaultPlural("投資家")).toBe("投資家");
		expect(defaultPlural("Инвестор")).toBe("Инвестор");
		expect(defaultPlural("مستثمر")).toBe("مستثمر");
	});
});
