import { describe, expect, it } from "bun:test";
import type { ConsentState } from "../../shared/ipc.ts";
import {
	chatAllowed,
	consentPromptNeeded,
	contextReadAllowed,
	engineAllowed,
	normalizeConsent,
} from "./consent-logic.ts";

function state(partial: Partial<ConsentState>): ConsentState {
	return normalizeConsent(partial);
}

describe("normalizeConsent", () => {
	it("defaults chat on and capture/proactive unanswered", () => {
		expect(normalizeConsent({})).toEqual({
			chat: true,
			contextRead: null,
			proactive: null,
		});
	});

	it("only an explicit false revokes chat", () => {
		expect(normalizeConsent({ chat: false }).chat).toBe(false);
		expect(normalizeConsent({ chat: true }).chat).toBe(true);
	});

	it("coerces non-boolean tri-state values to null", () => {
		const next = normalizeConsent({
			contextRead: "yes" as unknown as boolean,
			proactive: 1 as unknown as boolean,
		});
		expect(next.contextRead).toBeNull();
		expect(next.proactive).toBeNull();
	});
});

describe("contextReadAllowed (HARD GATE)", () => {
	it("blocks when unanswered or declined", () => {
		expect(contextReadAllowed(state({ contextRead: null }))).toBe(false);
		expect(contextReadAllowed(state({ contextRead: false }))).toBe(false);
	});

	it("opens only on an explicit grant", () => {
		expect(contextReadAllowed(state({ contextRead: true }))).toBe(true);
	});
});

describe("engineAllowed", () => {
	it("requires both contextRead and proactive", () => {
		expect(engineAllowed(state({ contextRead: true, proactive: false }))).toBe(
			false
		);
		expect(engineAllowed(state({ contextRead: false, proactive: true }))).toBe(
			false
		);
		expect(engineAllowed(state({ contextRead: true, proactive: true }))).toBe(
			true
		);
	});
});

describe("chatAllowed", () => {
	it("is true by default and false only when declined", () => {
		expect(chatAllowed(state({}))).toBe(true);
		expect(chatAllowed(state({ chat: false }))).toBe(false);
	});
});

describe("consentPromptNeeded", () => {
	it("is true while either capability is unanswered", () => {
		expect(consentPromptNeeded(state({}))).toBe(true);
		expect(
			consentPromptNeeded(state({ contextRead: true, proactive: null }))
		).toBe(true);
	});

	it("is false once both are answered", () => {
		expect(
			consentPromptNeeded(state({ contextRead: false, proactive: false }))
		).toBe(false);
	});
});
