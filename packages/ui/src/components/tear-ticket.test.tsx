import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TearTicket } from "./tear-ticket.tsx";

test("keeps the ticket content and marks its torn state", () => {
	const markup = renderToStaticMarkup(
		<TearTicket torn>
			<p>Invite pass redeemed</p>
		</TearTicket>
	);

	expect(markup).toContain('data-tear-state="torn"');
	expect(markup).toContain('data-tear-progress="1.00"');
	expect(markup).toContain('data-tear-piece="body"');
	expect(markup).toContain('data-tear-piece="stub"');
	expect(markup).toContain("Invite pass redeemed");
	expect(markup).toContain("used");
});

test("clamps partial tear progress and leaves unused tickets ready", () => {
	const readyMarkup = renderToStaticMarkup(
		<TearTicket>
			<p>Waitlist pass</p>
		</TearTicket>
	);
	const partialMarkup = renderToStaticMarkup(
		<TearTicket progress={4}>
			<p>Waitlist pass</p>
		</TearTicket>
	);

	expect(readyMarkup).toContain('data-tear-state="ready"');
	expect(readyMarkup).toContain('data-tear-progress="0.00"');
	expect(partialMarkup).toContain('data-tear-state="tearing"');
	expect(partialMarkup).toContain('data-tear-progress="1.00"');
});
