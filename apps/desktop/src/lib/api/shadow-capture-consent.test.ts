// apps/desktop/src/lib/api/shadow-capture-consent.test.ts
//
// The Core client for Shadow's capture consent. Reading never sends a change,
// a change names exactly one kind, and an answer that is not a complete
// consent state is an error, never "on".
//
// Mocking: `./shadow-fetch.ts` is replaced, so no request leaves the test.

import { afterEach, expect, mock, test } from "bun:test";

interface Sent {
	init: RequestInit | undefined;
	path: string;
}
const sent: Sent[] = [];
let answer: () => Response = () => new Response("{}", { status: 500 });

mock.module("./shadow-fetch.ts", () => ({
	shadowFetch: async (path: string, init?: RequestInit) => {
		sent.push({ path, init });
		return answer();
	},
}));

const {
	getShadowCaptureConsent,
	setShadowCaptureConsent,
	ShadowCaptureConsentError,
} = await import("./shadow-capture-consent.ts");

afterEach(() => {
	sent.length = 0;
	answer = () => new Response("{}", { status: 500 });
});

const off = {
	enabled: false,
	decided: false,
	decidedAt: null,
	configured: false,
};
const DIR = "/profile/services/shadow";
const fresh = {
	version: 1,
	recordState: "missing",
	kinds: { screen: off, microphone: off, input: off, activity: off },
	storage: {
		dataDir: DIR,
		screen: [`${DIR}/media/video`],
		microphone: [`${DIR}/media/audio`],
		input: [`${DIR}/events`],
		activity: [`${DIR}/events`],
	},
	shadowRunning: false,
};

function json(body: unknown, status = 200) {
	return () =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
}

async function refusal(run: () => Promise<unknown>) {
	try {
		await run();
	} catch (error) {
		return error;
	}
	return null;
}

test("reading asks Core and sends no change", async () => {
	answer = json(fresh);
	const consent = await getShadowCaptureConsent();
	expect(sent).toHaveLength(1);
	expect(sent[0]?.path).toBe("/capture/consent");
	expect(sent[0]?.init?.method).toBeUndefined();
	expect(sent[0]?.init?.body).toBeUndefined();
	expect(consent.recordState).toBe("missing");
	expect(Object.values(consent.kinds).some((kind) => kind.enabled)).toBe(false);
});

test("a change names one kind", async () => {
	answer = json({
		...fresh,
		recordState: "ok",
		kinds: {
			...fresh.kinds,
			microphone: {
				enabled: true,
				decided: true,
				decidedAt: "2026-11-18T12:00:00Z",
				configured: false,
			},
		},
		applied: "not_running",
	});
	const consent = await setShadowCaptureConsent("microphone", true);
	expect(sent).toHaveLength(1);
	expect(sent[0]?.path).toBe("/capture/consent");
	expect(sent[0]?.init?.method).toBe("POST");
	expect(JSON.parse(String(sent[0]?.init?.body))).toEqual({
		kind: "microphone",
		enabled: true,
	});
	expect(consent.kinds.microphone.enabled).toBe(true);
	expect(consent.kinds.screen.enabled).toBe(false);
	expect(consent.applied).toBe("not_running");
});

test("a refusal from Core keeps its code and message", async () => {
	answer = json(
		{
			error: {
				code: "capture_consent_local_only",
				message:
					"a capture kind can only be turned on from the device it captures",
			},
		},
		403
	);
	const error = await refusal(() => setShadowCaptureConsent("screen", true));
	expect(error).toBeInstanceOf(ShadowCaptureConsentError);
	if (error instanceof ShadowCaptureConsentError) {
		expect(error.code).toBe("capture_consent_local_only");
		expect(error.message).toContain("from the device it captures");
	}
});

test("an answer without every kind is an error, never a state", async () => {
	answer = json({
		...fresh,
		kinds: { screen: { ...off, enabled: true } },
	});
	const error = await refusal(() => getShadowCaptureConsent());
	expect(error).toBeInstanceOf(ShadowCaptureConsentError);
	if (error instanceof ShadowCaptureConsentError) {
		expect(error.code).toBe("invalid_response");
	}
});

test("an error that is not JSON reports the status", async () => {
	answer = () => new Response("bad gateway", { status: 502 });
	const error = await refusal(() => getShadowCaptureConsent());
	expect(error).toBeInstanceOf(ShadowCaptureConsentError);
	if (error instanceof ShadowCaptureConsentError) {
		expect(error.code).toBe("http_error");
	}
});
