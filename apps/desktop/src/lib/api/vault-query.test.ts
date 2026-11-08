import { expect, test } from "bun:test";
import { vaultQueryString } from "./vault-query.ts";

test("only defined, non-empty values reach the query string", () => {
	expect(vaultQueryString({})).toBe("");
	expect(vaultQueryString({ a: undefined, b: "" })).toBe("");
	expect(
		vaultQueryString({ before: 0, environment: "prod env", live: false })
	).toBe("?before=0&environment=prod+env&live=false");
});
