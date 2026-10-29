import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export type ResourceOwner = "day" | "timezone" | "foreign" | null;
export interface ConsumerCallsite {
	end: number | null;
	file: string;
	line: number;
	owner: ResourceOwner;
	start: number;
}
interface SourceMap {
	file: string;
	mappings: string;
	sources: string[];
}
const desktopRequire = createRequire(
	new URL("../package.json", import.meta.url)
);
const viteRequire = createRequire(desktopRequire.resolve("vite/package.json"));
// Use the decoder in the authentic locked Vite graph. No copied parser or
// replacement shipping module is introduced by this passive attribution.
const { decode } = viteRequire("@jridgewell/sourcemap-codec") as {
	decode: (mappings: string) => number[][][];
};

export function consumerCallsites(directory: string): ConsumerCallsite[] {
	const result: ConsumerCallsite[] = [];
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
			throw new Error(`Invalid authentic consumer source map: ${file}`);
		}
		const owners: Exclude<ResourceOwner, null>[] = map.sources.map((source) => {
			if (source.endsWith("/lib/display-day.ts")) {
				return "day";
			}
			if (source.endsWith("/lib/timezone.ts")) {
				return "timezone";
			}
			return "foreign";
		});
		for (const [lineIndex, segments] of decode(map.mappings).entries()) {
			for (const [index, segment] of segments.entries()) {
				const column = segment[0];
				const source = segment[1];
				const nextColumn = segments[index + 1]?.[0];
				if (
					!Number.isInteger(column) ||
					column === undefined ||
					column < 0 ||
					(segment.length !== 1 &&
						segment.length !== 4 &&
						segment.length !== 5) ||
					(nextColumn !== undefined &&
						(!Number.isInteger(nextColumn) || nextColumn <= column)) ||
					(segment.length >= 4 &&
						(source === undefined ||
							!Number.isInteger(source) ||
							source < 0 ||
							source >= owners.length))
				) {
					throw new Error(`Invalid authentic consumer attribution: ${file}`);
				}
				result.push({
					file: path.basename(map.file),
					line: lineIndex + 1,
					start: column,
					end: nextColumn ?? null,
					owner: source === undefined ? null : (owners[source] ?? null),
				});
			}
		}
	}
	for (const owner of ["day", "timezone"] as const) {
		if (!result.some((site) => site.owner === owner)) {
			throw new Error(`No authentic ${owner} consumer mapping`);
		}
	}
	// Keep every owned, foreign and unmapped boundary; unknown ownership cannot
	// silently turn an actual resource into an accepted zero.
	const compact: ConsumerCallsite[] = [];
	for (const site of result) {
		const previous = compact.at(-1);
		if (
			previous &&
			previous.file === site.file &&
			previous.line === site.line &&
			previous.end === site.start &&
			previous.owner === site.owner
		) {
			previous.end = site.end;
		} else {
			compact.push(site);
		}
	}
	return compact;
}
