import { describe, expect, it } from "bun:test";
import { EmailRateLimitError } from "@ryu/email";
import {
	INVITATION_EMAIL_NOT_SENT,
	INVITATION_EMAIL_RATE_LIMITED,
	invitationEmailNotSentError,
	invitationEmailWaitSeconds,
} from "./invitation-email-delivery.ts";

describe("invitationEmailWaitSeconds", () => {
	it("gives the cooldown as a whole minute and the daily cap in whole hours", () => {
		expect(invitationEmailWaitSeconds(1)).toBe(60);
		expect(invitationEmailWaitSeconds(40)).toBe(60);
		expect(invitationEmailWaitSeconds(60)).toBe(60);
		expect(invitationEmailWaitSeconds(61)).toBe(3600);
		expect(invitationEmailWaitSeconds(3600)).toBe(3600);
		expect(invitationEmailWaitSeconds(13 * 3600 + 40 * 60)).toBe(14 * 3600);
	});
});

describe("invitationEmailNotSentError", () => {
	it("answers a recipient cooldown with 429 and a whole-minute Retry-After, worded for a new invitation", () => {
		const error = invitationEmailNotSentError(
			new EmailRateLimitError("Notification email limit exceeded", 40),
			"invite"
		);
		expect(error.statusCode).toBe(429);
		expect(new Headers(error.headers).get("retry-after")).toBe("60");
		expect(error.body).toEqual({
			code: INVITATION_EMAIL_RATE_LIMITED,
			message:
				"Invitation email not sent, so no invitation was created. Please wait 60 seconds before sending it again.",
			retryAfter: 60,
		});
	});

	it("words a refused resend for the invitation that stays pending", () => {
		const error = invitationEmailNotSentError(
			{ code: "RATE_LIMIT_EXCEEDED", retryAfter: 44.2 },
			"resend"
		);
		expect(error.statusCode).toBe(429);
		expect(new Headers(error.headers).get("retry-after")).toBe("60");
		expect(error.body).toEqual({
			code: INVITATION_EMAIL_RATE_LIMITED,
			message:
				"Invitation email not sent. Please wait 60 seconds before resending it.",
			retryAfter: 60,
		});
	});

	it("gives a daily cap's wait in whole hours, rounded up", () => {
		const error = invitationEmailNotSentError(
			new EmailRateLimitError(
				"Notification email limit exceeded",
				13 * 3600 + 40 * 60
			),
			"invite"
		);
		expect(new Headers(error.headers).get("retry-after")).toBe(
			String(14 * 3600)
		);
		expect(error.body?.message).toBe(
			"Invitation email not sent, so no invitation was created. Please wait 14 hours before sending it again."
		);
	});

	it("answers a limit that refused without a delay (its store is unavailable) with 503, not a wait", () => {
		const error = invitationEmailNotSentError(
			new EmailRateLimitError(
				"Notification delivery is temporarily unavailable"
			),
			"resend"
		);
		expect(error.statusCode).toBe(503);
		expect(new Headers(error.headers).get("retry-after")).toBeNull();
		expect(error.body).toEqual({
			code: INVITATION_EMAIL_NOT_SENT,
			message:
				"Invitation email could not be sent. Try resending it in a few minutes.",
		});
	});

	it("answers any other failure, such as a provider outage, with 503", () => {
		const invite = invitationEmailNotSentError(
			new Error("Failed to send email: Provider temporarily unavailable"),
			"invite"
		);
		expect(invite.statusCode).toBe(503);
		expect(new Headers(invite.headers).get("retry-after")).toBeNull();
		expect(invite.body).toEqual({
			code: INVITATION_EMAIL_NOT_SENT,
			message:
				"Invitation email could not be sent, so no invitation was created. Try again in a few minutes.",
		});
		const resend = invitationEmailNotSentError(new Error("down"), "resend");
		expect(resend.statusCode).toBe(503);
		expect(resend.body).toEqual({
			code: INVITATION_EMAIL_NOT_SENT,
			message:
				"Invitation email could not be sent. Try resending it in a few minutes.",
		});
	});
});
