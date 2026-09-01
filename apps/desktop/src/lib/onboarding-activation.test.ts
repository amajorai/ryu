import { describe, expect, test } from "bun:test";
import type { ComposioConnection, ComposioToolkit } from "./api/composio.ts";
import {
	activationRewardProgress,
	buildActivationRecommendations,
	buildActivationTaskDraft,
	deriveActivationEligibility,
	ONBOARDING_REWARD_CAP_MICRO_USD,
	ONBOARDING_REWARD_PER_CONNECTION_MICRO_USD,
} from "./onboarding-activation.ts";

const toolkit = (slug: string, name = slug): ComposioToolkit => ({
	description: `${name} description`,
	logo: `${slug}-logo`,
	name,
	slug,
});

const connection = (
	toolkitSlug: string,
	active: boolean
): ComposioConnection => ({
	accessLevel: "risk_based",
	active,
	id: `${toolkitSlug}-connection`,
	status: active ? "ACTIVE" : "INITIATED",
	toolkit: toolkitSlug,
});

describe("onboarding activation", () => {
	test("uses fifty cents per connection and caps at ten dollars", () => {
		expect(ONBOARDING_REWARD_PER_CONNECTION_MICRO_USD).toBe(500_000);
		expect(ONBOARDING_REWARD_CAP_MICRO_USD).toBe(10_000_000);
		expect(activationRewardProgress(21)).toEqual({
			amountMicroUsd: 10_000_000,
			completed: 20,
			remaining: 0,
		});
	});

	test("recommends a useful app after an active email connection", () => {
		const rows = buildActivationRecommendations({
			connections: [connection("gmail", true)],
			toolkits: [toolkit("notion", "Notion"), toolkit("gmail", "Gmail")],
		});
		expect(rows[0]).toMatchObject({
			appSlug: "notion",
			reason: "This app fits the work Ryu found around your connected email.",
		});
	});

	test("prefers an active app for the first task", () => {
		const rows = buildActivationRecommendations({
			connections: [connection("gmail", true)],
			toolkits: [toolkit("notion", "Notion"), toolkit("gmail", "Gmail")],
		});
		expect(buildActivationTaskDraft(rows)).toMatchObject({
			appSlug: "gmail",
			title: "Turn recent email into a follow-up list",
		});
	});

	test("uses a generic task when no app signal exists", () => {
		expect(buildActivationTaskDraft([]).title).toBe("Find your next best task");
	});

	test("does not allow a shared non-owner node to create an activation task", () => {
		expect(
			deriveActivationEligibility({
				gateway: {
					allowed: false,
					managedNode: false,
					reason: "shared_acl_node",
					scope: "org",
				},
				ownerOrAdmin: false,
			}).taskAllowed
		).toBe(false);
	});

	test("allows an owner on a local self-hosted node", () => {
		expect(
			deriveActivationEligibility({
				gateway: {
					allowed: true,
					managedNode: false,
					reason: "local_node",
					scope: null,
				},
				ownerOrAdmin: true,
			}).taskAllowed
		).toBe(true);
	});
});
