// apps/desktop/src/lib/api/shadow-capture-consent.ts
//
// The user's capture consent for Shadow, one decision per capture kind. Core
// owns the record (`/api/shadow/capture/consent`); Shadow opens a capture
// device only for a kind the record turns on. A profile without a record
// captures nothing.

import { z } from "zod";
import { shadowFetch } from "./shadow-fetch.ts";

export const SHADOW_CAPTURE_KINDS = [
	"screen",
	"microphone",
	"input",
	"activity",
] as const;

export type ShadowCaptureKind = (typeof SHADOW_CAPTURE_KINDS)[number];

const kindStateSchema = z.object({
	/** Whether this kind captures now. */
	enabled: z.boolean(),
	/** Whether the user decided this kind (on or off). */
	decided: z.boolean(),
	decidedAt: z.string().nullable(),
	/** Whether this device's configuration turns the kind on. */
	configured: z.boolean(),
});

const consentSchema = z.object({
	version: z.number(),
	recordState: z.enum(["missing", "ok", "unusable"]),
	kinds: z.object({
		screen: kindStateSchema,
		microphone: kindStateSchema,
		input: kindStateSchema,
		activity: kindStateSchema,
	}),
	storage: z.object({
		dataDir: z.string(),
		screen: z.array(z.string()),
		microphone: z.array(z.string()),
		input: z.array(z.string()),
		activity: z.array(z.string()),
	}),
	shadowRunning: z.boolean(),
	/** Present after a change: how it reached the running Shadow. */
	applied: z.enum(["not_running", "restarted", "stopped", "failed"]).optional(),
});

export type ShadowCaptureConsent = z.infer<typeof consentSchema>;
export type ShadowCaptureKindState = z.infer<typeof kindStateSchema>;

const coreErrorSchema = z.object({
	error: z.object({ code: z.string(), message: z.string() }),
});

/** A refusal from Core, with its stable `code`. */
export class ShadowCaptureConsentError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "ShadowCaptureConsentError";
		this.code = code;
	}
}

async function consentError(response: Response): Promise<Error> {
	try {
		const parsed = coreErrorSchema.safeParse(await response.json());
		if (parsed.success) {
			return new ShadowCaptureConsentError(
				parsed.data.error.code,
				parsed.data.error.message
			);
		}
	} catch {
		// Not JSON: report the status below.
	}
	return new ShadowCaptureConsentError(
		"http_error",
		`Core answered ${response.status}`
	);
}

async function readConsent(response: Response): Promise<ShadowCaptureConsent> {
	if (!response.ok) {
		throw await consentError(response);
	}
	const parsed = consentSchema.safeParse(await response.json());
	if (!parsed.success) {
		throw new ShadowCaptureConsentError(
			"invalid_response",
			"Core returned an invalid capture consent"
		);
	}
	return parsed.data;
}

/** Read the consent state. Never changes it. */
export async function getShadowCaptureConsent(): Promise<ShadowCaptureConsent> {
	return readConsent(
		await shadowFetch("/capture/consent", {
			headers: { Accept: "application/json" },
		})
	);
}

/** Turn one capture kind on or off. Core applies it to a running Shadow at once. */
export async function setShadowCaptureConsent(
	kind: ShadowCaptureKind,
	enabled: boolean
): Promise<ShadowCaptureConsent> {
	return readConsent(
		await shadowFetch("/capture/consent", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({ kind, enabled }),
		})
	);
}
