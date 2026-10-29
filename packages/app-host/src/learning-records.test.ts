import { describe, expect, test } from "bun:test";
import {
	learningConfigSchema,
	learningExperienceListSchema,
	learningHealingStatusSchema,
} from "./learning-records.ts";
import type { RouteClaim } from "./rpc.ts";
import { type Capability, dispatchRpc, type HostServices } from "./rpc.ts";

const config = {
	base_model: null,
	enabled: false,
	min_reward: 0.3,
	prm_model: "reward-model",
	prm_via_byo: true,
	skill_generation: 2,
	skills_enabled: true,
	synth_model: "synth-model",
	future: { nested: [null, true] },
};
const experience = {
	agent_id: null,
	assistant_text: "reply",
	base_model: null,
	conversation_id: "chat",
	excluded: false,
	id: "experience",
	outcome: "accepted",
	reward: null,
	skill_generation: 1,
	user_text: "prompt",
	future: { nested: [true] },
};
const buffer = {
	experiences: [experience],
	min_reward: 0.3,
	scored: 1,
	total: 2,
	trainable: 1,
	future: { retained: true },
};
const attempt = {
	count: 1,
	given_up: false,
	last_at: 123,
	future: { retained: true },
};
const status = {
	attempts: { "job:1": attempt, conversation: attempt },
	future: { retained: true },
};

describe("Core learning response owners", () => {
	test("preserves complete config, nullable fields, original rows and additive JSON metadata", () => {
		expect(learningConfigSchema.parse(config)).toBe(config);
		expect(learningExperienceListSchema.parse(buffer)).toBe(buffer);
		expect(learningExperienceListSchema.parse(buffer).experiences).toBe(
			buffer.experiences
		);
		expect(learningExperienceListSchema.parse(buffer).experiences[0]).toBe(
			experience
		);
		expect(learningHealingStatusSchema.parse(status)).toBe(status);
		expect(learningHealingStatusSchema.parse(status).attempts).toBe(
			status.attempts
		);
		expect(learningHealingStatusSchema.parse(status).attempts["job:1"]).toBe(
			attempt
		);
	});
	test("rejects malformed known fields and unsupported additive values", () => {
		expect(
			learningConfigSchema.safeParse({ ...config, enabled: "false" }).success
		).toBe(false);
		expect(
			learningConfigSchema.safeParse({ ...config, base_model: 3 }).success
		).toBe(false);
		expect(
			learningConfigSchema.safeParse({ ...config, future: () => null }).success
		).toBe(false);
		expect(
			learningExperienceListSchema.safeParse({
				...buffer,
				experiences: [{ ...experience, reward: "0.3" }],
			}).success
		).toBe(false);
		expect(
			learningExperienceListSchema.safeParse({
				...buffer,
				experiences: [{ ...experience, conversation_id: null }],
			}).success
		).toBe(false);
		expect(
			learningHealingStatusSchema.safeParse({
				...status,
				attempts: { conversation: { ...attempt, last_at: "now" } },
			}).success
		).toBe(false);
	});
	test("retains and validates original prototype-named map entries", () => {
		const attempts = JSON.parse(
			'{"__proto__":{"count":1,"given_up":false,"last_at":123}}'
		);
		const original = { attempts };
		expect(learningHealingStatusSchema.parse(original)).toBe(original);
		expect(learningHealingStatusSchema.parse(original).attempts).toBe(attempts);
		const invalid = {
			attempts: Object.defineProperty({}, "__proto__", {
				value: { count: 1, given_up: "false", last_at: 123 },
				enumerable: true,
			}),
		};
		expect(learningHealingStatusSchema.safeParse(invalid).success).toBe(false);
		const invalidMetadata = Object.defineProperty({ ...config }, "__proto__", {
			value: () => null,
			enumerable: true,
		});
		expect(learningConfigSchema.safeParse(invalidMetadata).success).toBe(false);
	});
	test("all three privileged learning methods use the canonical decoders", async () => {
		const capabilities: Set<Capability> = new Set(["learning.crud"]);
		const services: HostServices = {
			listAgents: async () => [],
			registerRoute: async (claim: RouteClaim) => ({ path: claim.path }),
			learningConfig: async () => config,
			learningExperience: async () => buffer,
			learningHealing: async () => status,
		};
		expect(
			await dispatchRpc("learning.config", [], capabilities, services)
		).toBe(config);
		expect(
			await dispatchRpc("learning.experience", [], capabilities, services)
		).toBe(buffer);
		expect(
			await dispatchRpc("learning.healing", [], capabilities, services)
		).toBe(status);
	});
});
