// The compose window's recipient field reads "To" through its own sense id:
// the bare catalog row is a destination ("移動先"), not a message addressee.
import { expect, test } from "bun:test";
import { I18nProvider } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import { usefulStateFixture } from "./game-acts-fixture.ts";
import { MailCompose } from "./mail-compose.tsx";

/** A stand-in for the destination sense of the bare catalog row. */
const OVERLAYS = { ja: { To: "移動先" } };

function recipientLabel(locale: string): string | undefined {
	const html = renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale={locale}
			manageDocument={false}
			overlays={OVERLAYS}
		>
			<MailCompose
				defaultAgentId={null}
				label={null}
				onClose={() => undefined}
				onSend={() => undefined}
				snapshot={usefulStateFixture()}
			/>
		</I18nProvider>
	);
	return /<label[^>]*for="[^"]*-to"[^>]*>([^<]*)<\/label>/u.exec(html)?.[1];
}

test("the Japanese compose window addresses the message to 宛先", () => {
	expect(recipientLabel("ja")).toBe("宛先");
});

test("the German and Arabic compose windows use the addressee word", () => {
	expect(recipientLabel("de")).toBe("An");
	expect(recipientLabel("ar")).toBe("إلى");
});

test("the English compose window keeps the To label", () => {
	expect(recipientLabel("en")).toBe("To");
});
