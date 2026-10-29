import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import DeprecationNotice from "./deprecation-notice.tsx";

describe("DeprecationNotice", () => {
	test("renders the publisher's message and the replacement id", () => {
		const html = renderToStaticMarkup(
			<DeprecationNotice
				message="Superseded by the v2 connector."
				name="Old Tool"
				replacement="@acme/new-tool"
			/>
		);
		expect(html).toContain('data-testid="deprecation-notice"');
		expect(html).toContain("Superseded by the v2 connector.");
		expect(html).toContain("@acme/new-tool");
	});

	test("falls back to a neutral sentence when no message is given", () => {
		const html = renderToStaticMarkup(<DeprecationNotice name="Old Tool" />);
		expect(html).toContain("The publisher has deprecated Old Tool.");
		expect(html).not.toContain("instead.");
	});
});
