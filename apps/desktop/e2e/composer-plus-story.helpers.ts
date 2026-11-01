// Page probes shared by composer-plus-story.spec.ts: the compact composer's
// height-morph sampler and the "+" trigger locator.

import type { Page } from "@playwright/test";

export interface CompactMorphEvidence {
	finalHeight: number;
	frameDeltas: number[];
	initialHeight: number;
	sameToolbarNode: boolean;
	samples: {
		height: number;
		layout: string | null;
		time: number;
	}[];
}

export async function collectCompactMorphEvidence(
	page: Page
): Promise<CompactMorphEvidence> {
	return page.evaluate(
		() =>
			new Promise<CompactMorphEvidence>((resolve, reject) => {
				const toolbar = document.querySelector<HTMLElement>(
					'[data-testid="compact"] [data-composer-layout]'
				);
				if (!toolbar) {
					reject(new Error("compact composer layout marker is missing"));
					return;
				}

				const initialToolbar = toolbar;
				const initialHeight = toolbar.getBoundingClientRect().height;
				const samples: CompactMorphEvidence["samples"] = [];
				const startedAt = performance.now();

				const collect = (now: number) => {
					const rect = toolbar.getBoundingClientRect();
					samples.push({
						height: rect.height,
						layout: toolbar.getAttribute("data-composer-layout"),
						time: now - startedAt,
					});
					if (now - startedAt < 800) {
						requestAnimationFrame(collect);
						return;
					}

					resolve({
						finalHeight: samples.at(-1)?.height ?? initialHeight,
						frameDeltas: samples
							.slice(1)
							.map((sample, index) => sample.height - samples[index]!.height),
						initialHeight,
						sameToolbarNode:
							initialToolbar ===
							document.querySelector(
								'[data-testid="compact"] [data-composer-layout]'
							),
						samples,
					});
				};

				requestAnimationFrame(collect);
			})
	);
}

/** The "+" trigger inside one of the story's two mounts. */
export function plusIn(page: Page, testId: string) {
	return page.getByTestId(testId).getByRole("button", { name: "Add" });
}
