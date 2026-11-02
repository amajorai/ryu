// Walk-and-talk helpers for interfaces-proof.spec.ts: the World 2D and
// World 3D renderers both offer the agent in reach through a status prompt,
// and the player walks with the arrow keys.

import { expect, type Page } from "@playwright/test";

const MAX_STEPS_TO_AGENT = 8;

/**
 * Walk the player north from spawn until an agent is within reach, then
 * return the name the world offers to talk to. World 3D's prompt reads
 * "Press E to talk to <name>" since 2c940ae07d translated it as a whole
 * sentence; World 2D's reads "Talk to <name>".
 */
export async function walkUpToNearestAgent(page: Page): Promise<string> {
	const status = talkPrompt(page);
	for (let step = 0; step < MAX_STEPS_TO_AGENT; step += 1) {
		if ((await status.count()) > 0) {
			break;
		}
		await page.keyboard.press("ArrowUp");
	}
	await expect(status).toBeVisible();
	return promptedName(page);
}

function talkPrompt(page: Page) {
	return page.getByRole("status").filter({ hasText: TALK_PROMPT });
}

export async function promptedName(page: Page): Promise<string> {
	const text = (await talkPrompt(page).textContent()) ?? "";
	return text.replace(TALK_PROMPT_PREFIX, "").trim();
}

const TALK_PROMPT = /talk to/i;
const TALK_PROMPT_PREFIX = /^.*talk to\s+/i;
const WORLD_2D_TILE_PX = 96;
const MAX_WALK_KEYS = 80;
const STEPS = {
	ArrowDown: { x: 0, y: 1 },
	ArrowLeft: { x: -1, y: 0 },
	ArrowRight: { x: 1, y: 0 },
	ArrowUp: { x: 0, y: -1 },
} as const;
type StepKey = keyof typeof STEPS;
const REVERSE: Record<StepKey, StepKey> = {
	ArrowDown: "ArrowUp",
	ArrowLeft: "ArrowRight",
	ArrowRight: "ArrowLeft",
	ArrowUp: "ArrowDown",
};

/**
 * The player's tile relative to `name`'s tile, from the "You" marker's and the
 * agent's talk button's feet on screen (both move with the camera, so the
 * difference is camera-independent).
 */
async function tileFrom(
	page: Page,
	name: string
): Promise<{ x: number; y: number }> {
	const you = await page.getByRole("img", { name: "You" }).boundingBox();
	const agent = await page
		.getByRole("button", { name: `Talk to ${name}`, exact: true })
		.boundingBox();
	if (!(you && agent)) {
		throw new Error(`World 2D: "You" or ${name} is not on the map`);
	}
	return {
		x: Math.round(
			(you.x + you.width / 2 - (agent.x + agent.width / 2)) / WORLD_2D_TILE_PX
		),
		y: Math.round(
			(you.y + you.height - (agent.y + agent.height)) / WORLD_2D_TILE_PX
		),
	};
}

/** Presses `key` and returns where the player stands once the step settles. */
async function step(
	page: Page,
	name: string,
	key: StepKey,
	from: { x: number; y: number }
): Promise<{ x: number; y: number }> {
	await page.keyboard.press(key);
	const target = { x: from.x + STEPS[key].x, y: from.y + STEPS[key].y };
	try {
		await expect
			.poll(() => tileFrom(page, name), { timeout: 600 })
			.toEqual(target);
		return target;
	} catch {
		// Fences, cottages, lamps and furniture block the step.
		return tileFrom(page, name);
	}
}

/**
 * Walks the World 2D player to `name` the way a person would: a depth-first
 * walk over the village's streets toward the agent's position (read from its
 * talk button), stepping round whatever blocks the way, until the "E" prompt
 * offers that agent. The village (cottages, fences, furniture and the act
 * places villagers stand on) is laid out from the snapshot, so no fixed key
 * sequence survives a layout change.
 */
export async function walkTo2dAgent(page: Page, name: string): Promise<void> {
	const key = (tile: { x: number; y: number }) => `${tile.x},${tile.y}`;
	let here = await tileFrom(page, name);
	const visited = new Set([key(here)]);
	const trail: StepKey[] = [];
	for (let presses = 0; presses < MAX_WALK_KEYS; presses += 1) {
		// Within reach: one tile away, diagonals included.
		if (Math.max(Math.abs(here.x), Math.abs(here.y)) <= 1) {
			break;
		}
		const options = (Object.keys(STEPS) as StepKey[])
			.map((stepKey) => ({
				stepKey,
				tile: { x: here.x + STEPS[stepKey].x, y: here.y + STEPS[stepKey].y },
			}))
			.filter(({ tile }) => !visited.has(key(tile)))
			.sort(
				(a, b) =>
					Math.abs(a.tile.x) +
					Math.abs(a.tile.y) -
					(Math.abs(b.tile.x) + Math.abs(b.tile.y))
			);
		const next = options[0];
		if (next) {
			visited.add(key(next.tile));
			const moved = await step(page, name, next.stepKey, here);
			if (key(moved) === key(next.tile)) {
				trail.push(next.stepKey);
				here = moved;
			}
			continue;
		}
		const back = trail.pop();
		if (!back) {
			break;
		}
		here = await step(page, name, REVERSE[back], here);
	}
	await expect(talkPrompt(page)).toHaveText(`ETalk to ${name}`);
}
