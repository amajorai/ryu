import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InvitePass } from "./invite-pass.tsx";
import { PassQrBack } from "./pass-qr-back.tsx";
import { ReferralPass } from "./referral-pass.tsx";
import { SensitiveDataScope, SensitiveValue } from "./sensitive-value.tsx";

test("initial HTML omits secrets from text and attributes", () => {
	const html = renderToStaticMarkup(
		<SensitiveDataScope>
			<SensitiveValue label="API key" value="never-render-this-secret" />
		</SensitiveDataScope>
	);
	expect(html).not.toContain("never-render-this-secret");
	expect(html).toContain("••••••••");
	expect(html).toContain('aria-label="Reveal API key"');
	expect(html).toContain('aria-pressed="false"');
});

test("pass fronts and backs omit codes and QR modules by default", () => {
	const html = renderToStaticMarkup(
		<>
			<ReferralPass
				code="referral-secret"
				referralUrl="https://example.com/?ref=referral-secret"
				still
			/>
			<InvitePass
				code="invite-secret"
				expiresAt="2099-01-01T00:00:00Z"
				inviteUrl="https://example.com/invite/invite-secret"
				used={false}
			/>
			<PassQrBack
				caption="Scan to invite"
				seed="member"
				value="https://example.com/?ref=waitlist-secret"
			/>
		</>
	);
	for (const secret of [
		"referral-secret",
		"invite-secret",
		"waitlist-secret",
	]) {
		expect(html).not.toContain(secret);
	}
	expect(html).toContain("Invite QR hidden");
	expect(html).not.toContain('aria-label="Scan to invite"');
});
