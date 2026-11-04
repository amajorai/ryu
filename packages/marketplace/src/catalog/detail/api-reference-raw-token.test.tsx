import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RawToken } from "./api-reference-raw-token.tsx";

describe("RawToken", () => {
	test("shows the label, then the token verbatim in a code chip", () => {
		const markup = renderToStaticMarkup(
			<RawToken label="Runs on a hook event" token="before_turn" />
		);
		expect(markup).toStartWith("Runs on a hook event <code");
		expect(markup).toContain(">before_turn</code>");
	});
});
