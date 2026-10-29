import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

interface SourceMap {
	file: string;
	mappings: string;
	sources: string[];
}
export interface TemporalCallsite {
	end: number | null;
	file: string;
	line: number;
	owned: boolean | null;
	start: number;
}
const desktopRequire = createRequire(
	new URL("../package.json", import.meta.url)
);
const viteRequire = createRequire(desktopRequire.resolve("vite/package.json"));
// Use Vite's authentic locked source-map decoder, not a copied VLQ parser.
const { decode } = viteRequire("@jridgewell/sourcemap-codec") as {
	decode: (mappings: string) => number[][][];
};

// This audits original callsite ownership only. Native timers, events, the clock
// and the shipping day hook all remain intact in the production bundle.
export function temporalCallsites(directory: string): TemporalCallsite[] {
	const result: TemporalCallsite[] = [];
	for (const file of readdirSync(path.join(directory, "assets"))) {
		if (!file.endsWith(".js.map")) {
			continue;
		}
		const map = JSON.parse(
			readFileSync(path.join(directory, "assets", file), "utf8")
		) as SourceMap;
		if (
			typeof map.file !== "string" ||
			!map.file ||
			typeof map.mappings !== "string" ||
			!Array.isArray(map.sources) ||
			map.sources.some((source) => typeof source !== "string")
		) {
			throw new Error(`Invalid authentic source-map metadata: ${file}`);
		}
		const owners = new Set(
			map.sources.flatMap((source, index) =>
				source.endsWith("/lib/display-day.ts") ? [index] : []
			)
		);
		for (const [lineIndex, segments] of decode(map.mappings).entries()) {
			for (const [index, segment] of segments.entries()) {
				const generatedColumn = segment[0];
				const sourceIndex = segment[1];
				if (
					typeof generatedColumn !== "number" ||
					(segment.length !== 1 &&
						segment.length !== 4 &&
						segment.length !== 5) ||
					(segment.length >= 4 &&
						(typeof sourceIndex !== "number" ||
							!Number.isInteger(sourceIndex) ||
							sourceIndex < 0 ||
							sourceIndex >= map.sources.length))
				) {
					throw new Error(`Invalid authentic source-map attribution: ${file}`);
				}
				result.push({
					file: path.basename(map.file),
					line: lineIndex + 1,
					start: generatedColumn,
					end: segments[index + 1]?.[0] ?? null,
					owned: sourceIndex === undefined ? null : owners.has(sourceIndex),
				});
			}
		}
	}
	if (!result.some((site) => site.owned === true)) {
		throw new Error("No authentic display-day source-map callsites found");
	}
	// Adjacent segments with the same attribution are one exact interval. Keep
	// every ownership boundary, including unmapped gaps, without serializing each
	// foreign token into the browser fixture.
	const compact: TemporalCallsite[] = [];
	for (const site of result) {
		const previous = compact.at(-1);
		if (
			previous &&
			previous.file === site.file &&
			previous.line === site.line &&
			previous.end === site.start &&
			previous.owned === site.owned
		) {
			previous.end = site.end;
		} else {
			compact.push(site);
		}
	}
	return compact;
}
