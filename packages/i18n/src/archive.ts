import { strToU8, unzipSync, zipSync } from "fflate";
import { z } from "zod";
import {
	LANGUAGE_PACK_ARTIFACT,
	LANGUAGE_PACK_SCHEMA_VERSION,
	type LanguagePack,
	LanguagePackValidationError,
	languagePackJson,
	languagePackSummary,
	MAX_LANGUAGE_PACK_ARCHIVE_BYTES,
	MAX_LANGUAGE_PACK_BYTES,
	parseLanguagePackJson,
	validateLanguagePack,
} from "./pack.ts";

// Portable `.ryupack` packaging. It is kept apart from the runtime so the zip
// codec and manifest schema load only where a pack is exported or imported.

const languagePackMetadataSchema = z.record(z.string(), z.json());

/** Build the portable-package envelope for a language pack without executable artifacts. */
export function languagePackPortableManifest(
	pack: LanguagePack,
	options: {
		metadata?: Parameters<typeof languagePackMetadataSchema.parse>[0];
	} = {}
) {
	const validated = validateLanguagePack(pack);
	const metadata = languagePackMetadataSchema.parse(options.metadata ?? {});
	return {
		artifacts: [LANGUAGE_PACK_ARTIFACT],
		capabilities: [],
		id: validated.id,
		kind: "language_pack",
		metadata: {
			...metadata,
			category: metadata.category ?? "Language Packs",
			languagePack: languagePackSummary(validated),
		},
		name: validated.name,
		requires: {},
		schemaVersion: LANGUAGE_PACK_SCHEMA_VERSION,
		security: {
			containsSecrets: false,
			permissions: [],
			privateContent: false,
			redacted: false,
		},
		scopes: ["desktop"],
		targets: ["desktop", "web", "mobile", "extension", "island"],
		version: validated.version,
	};
}

/** Create a browser-safe deterministic `.ryupack` for download or local sharing. */
export function languagePackArchive(pack: LanguagePack): Uint8Array {
	const validated = validateLanguagePack(pack);
	const manifest = languagePackPortableManifest(validated);
	return zipSync(
		{
			"ryu.package.json": [
				strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
				{ mtime: new Date("1980-01-01T00:00:00.000Z") },
			],
			[LANGUAGE_PACK_ARTIFACT]: [
				strToU8(languagePackJson(validated)),
				{ mtime: new Date("1980-01-01T00:00:00.000Z") },
			],
		},
		{ level: 6, mtime: 0 }
	);
}

const portableManifestSchema = z.object({
	kind: z.literal("language_pack"),
	schemaVersion: z.literal(LANGUAGE_PACK_SCHEMA_VERSION),
	id: z.string().catch("").optional(),
	version: z.string().catch("").optional(),
	artifacts: z.tuple([z.literal(LANGUAGE_PACK_ARTIFACT)]),
	capabilities: z.array(z.unknown()).length(0),
	security: z.object({
		permissions: z.array(z.unknown()).length(0),
		containsSecrets: z
			.unknown()
			.transform((value) => value === true)
			.refine((value) => !value),
		privateContent: z
			.unknown()
			.transform((value) => value === true)
			.refine((value) => !value),
	}),
});

function unzipLanguagePackArchive(data: Uint8Array) {
	let entryCount = 0;
	let uncompressedBytes = 0;
	const entries = unzipSync(data, {
		filter: (entry) => {
			entryCount += 1;
			uncompressedBytes += entry.originalSize;
			if (entryCount > 2) {
				throw new LanguagePackValidationError([
					{ path: "archive", message: "must contain only two files" },
				]);
			}
			if (entry.originalSize > MAX_LANGUAGE_PACK_BYTES) {
				throw new LanguagePackValidationError([
					{
						path: entry.name,
						message: `must be at most ${MAX_LANGUAGE_PACK_BYTES} bytes`,
					},
				]);
			}
			if (uncompressedBytes > MAX_LANGUAGE_PACK_ARCHIVE_BYTES) {
				throw new LanguagePackValidationError([
					{ path: "archive", message: "expands beyond the archive limit" },
				]);
			}
			if (
				entry.name !== "ryu.package.json" &&
				entry.name !== LANGUAGE_PACK_ARTIFACT
			) {
				throw new LanguagePackValidationError([
					{
						path: entry.name,
						message: "must not contain executable or unrelated files",
					},
				]);
			}
			return true;
		},
	});
	return { entries, entryCount };
}

/** Parse the standard data-only `.ryupack` emitted by `languagePackArchive`. */
export function parseLanguagePackArchive(data: Uint8Array): LanguagePack {
	if (data.byteLength > MAX_LANGUAGE_PACK_ARCHIVE_BYTES) {
		throw new LanguagePackValidationError([
			{
				path: "archive",
				message: `must be at most ${MAX_LANGUAGE_PACK_ARCHIVE_BYTES} bytes`,
			},
		]);
	}
	const { entries, entryCount } = unzipLanguagePackArchive(data);
	const artifact = entries[LANGUAGE_PACK_ARTIFACT];
	const manifest = entries["ryu.package.json"];
	if (!(artifact && manifest) || entryCount !== 2) {
		throw new LanguagePackValidationError([
			{
				path: "archive",
				message: "must contain ryu.package.json and language-pack.json",
			},
		]);
	}
	let manifestValue: unknown;
	try {
		manifestValue = JSON.parse(new TextDecoder().decode(manifest));
	} catch {
		throw new LanguagePackValidationError([
			{ path: "ryu.package.json", message: "must contain valid JSON" },
		]);
	}
	const parsedManifest = portableManifestSchema.safeParse(manifestValue);
	if (!parsedManifest.success) {
		throw new LanguagePackValidationError([
			{
				path: "ryu.package.json",
				message: "must describe a language_pack with language-pack.json only",
			},
		]);
	}

	const pack = parseLanguagePackJson(new TextDecoder().decode(artifact));
	if (
		parsedManifest.data.id !== pack.id ||
		parsedManifest.data.version !== pack.version
	) {
		throw new LanguagePackValidationError([
			{
				path: "ryu.package.json",
				message: "id and version must match language-pack.json",
			},
		]);
	}
	return pack;
}
