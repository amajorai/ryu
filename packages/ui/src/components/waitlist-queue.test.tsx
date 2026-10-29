import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WaitlistPass } from "./waitlist-pass.tsx";
import { WaitlistQueue } from "./waitlist-queue.tsx";
import {
	WaitlistHandleStep,
	WaitlistShareStep,
} from "./waitlist-queue-steps.tsx";

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

test("waitlist referral link is shown in full with no reveal controls", () => {
	const html = renderToStaticMarkup(
		<WaitlistQueue
			{...requiredProps}
			loaded
			referralUrl="https://ryuhq.com/r/ABCD2345"
			reserved="member"
			subtitle="Stay close to the queue."
		/>
	);

	expect(html).toContain("/r/ABCD2345");
	expect(html).not.toContain("Reveal");
	expect(html).not.toContain("••••");
});

test("the username nudge lives on the handle step, not the share step", () => {
	const handleStep = (reserved: string | null) =>
		renderToStaticMarkup(
			<WaitlistHandleStep
				handle=""
				onChangeHandle={() => {}}
				onReserve={() => {}}
				reserved={reserved}
				reserving={false}
			/>
		);
	const nudge = "Claim your username before it&#x27;s taken.";
	expect(handleStep(null)).toContain(nudge);
	// Once the handle is yours the nudge has nothing left to ask for.
	expect(handleStep("member")).not.toContain(nudge);

	const shareStep = renderToStaticMarkup(
		<WaitlistShareStep
			copied={false}
			metalTheme="light"
			onCopyReferral={() => {}}
			onShare={() => {}}
			referralCount={0}
			referralUrl="https://ryuhq.com/r/ABCD2345"
		/>
	);
	expect(shareStep).not.toContain(nudge);
	expect(shareStep).toContain("/r/ABCD2345");
});

test("the waitlist pass shows its invite QR with no reveal toggle", () => {
	const html = renderToStaticMarkup(
		<WaitlistPass
			referralUrl="https://ryuhq.com/r/ABCD2345"
			username="member"
		/>
	);

	expect(html).toContain('aria-label="Scan to invite"');
	expect(html).not.toContain("Invite QR hidden");
	expect(html).not.toContain("Reveal");
});
