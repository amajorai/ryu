import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageInput } from "./message-input.tsx";

describe("Island MessageInput", () => {
	test("uses the shared compact composer with the island placeholder", () => {
		const html = renderToStaticMarkup(
			<MessageInput onSend={() => undefined} />
		);

		expect(html).toContain('data-composer-layout="compact"');
		expect(html).toContain('placeholder="Ask Ryu…"');
	});
});
