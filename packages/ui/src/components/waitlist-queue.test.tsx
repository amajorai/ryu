import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WaitlistQueue } from "./waitlist-queue.tsx";

const requiredProps = {
	handle: "",
	onChangeHandle: () => {},
	onCopyReferral: () => {},
	onReserve: () => {},
	onShare: () => {},
	onSignOut: () => {},
};

test("waitlist status can expose the community link beside account actions", () => {
	const html = renderToStaticMarkup(
		<WaitlistQueue
			{...requiredProps}
			discordHref="https://discord.gg/3RxeVyvdjG"
			loaded
			subtitle="Stay close to the queue."
		/>
	);

	expect(html).toContain("Join our Discord");
	expect(html).toContain('href="https://discord.gg/3RxeVyvdjG"');
	expect(html).toContain('target="_blank"');
	expect(html).toContain('rel="noopener noreferrer"');
});

test("waitlist status does not render an optional community link by default", () => {
	const html = renderToStaticMarkup(
		<WaitlistQueue
			{...requiredProps}
			loaded
			subtitle="Stay close to the queue."
		/>
	);

	expect(html).not.toContain("Join our Discord");
});

test("waitlist sharing exposes the next referral checkpoint", () => {
	const html = renderToStaticMarkup(
		<WaitlistQueue
			{...requiredProps}
			loaded
			referralCount={2}
			referralUrl="https://ryuhq.com/?ref=abc123"
			reserved="member"
			subtitle="Stay close to the queue."
		/>
	);

	expect(html).toContain('data-goal-gradient="waitlist-referrals"');
	expect(html).toContain("Your next queue goal");
	expect(html).toContain("One more friend reaches your next checkpoint.");
	expect(html).toContain("2 referrals");
	expect(html).toContain("> / 3<");
});

test("waitlist status links a same-site Discord path in the current tab", () => {
	const html = renderToStaticMarkup(
		<WaitlistQueue
			{...requiredProps}
			discordHref="/discord"
			loaded
			subtitle="Stay close to the queue."
		/>
	);

	expect(html).toContain("Join our Discord");
	expect(html).toContain('href="/discord"');
	expect(html).not.toContain('target="_blank"');
});

test("waitlist status refuses a protocol-relative Discord path", () => {
	const html = renderToStaticMarkup(
		<WaitlistQueue
			{...requiredProps}
			discordHref="//evil.example/discord"
			loaded
			subtitle="Stay close to the queue."
		/>
	);

	expect(html).not.toContain("Join our Discord");
});
