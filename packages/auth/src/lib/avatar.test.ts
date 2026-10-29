import { beforeEach, expect, mock, test } from "bun:test";

/**
 * Avatar storage helpers. A replace must validate the new image before it
 * touches storage, and the cleanup helpers must reach every object they own:
 * a single unpaginated list stopped at the first page of keys.
 */

interface RecordedCommand {
	input: Record<string, unknown>;
	kind: string;
}

const sent: RecordedCommand[] = [];
let listPages: { Key: string }[][] = [];

function command(kind: string) {
	return class {
		readonly input: Record<string, unknown>;
		readonly kind = kind;
		constructor(input: Record<string, unknown>) {
			this.input = input;
		}
	};
}

mock.module("@aws-sdk/client-s3", () => ({
	DeleteObjectCommand: command("DeleteObject"),
	ListObjectsV2Command: command("ListObjectsV2"),
	PutObjectCommand: command("PutObject"),
	S3Client: class {
		send(request: RecordedCommand) {
			sent.push({ input: request.input, kind: request.kind });
			if (request.kind !== "ListObjectsV2") {
				return Promise.resolve({});
			}
			const token = request.input.ContinuationToken;
			const page = typeof token === "string" ? Number(token) : 0;
			const next = page + 1;
			return Promise.resolve({
				Contents: listPages[page] ?? [],
				IsTruncated: next < listPages.length,
				NextContinuationToken:
					next < listPages.length ? String(next) : undefined,
			});
		}
	},
}));

const {
	AvatarValidationError,
	assertValidAvatarInput,
	deleteAvatarSet,
	deleteUserAvatarFiles,
	processAndUploadAvatar,
} = await import("./avatar.ts");

const deletedKeys = () =>
	sent
		.filter((entry) => entry.kind === "DeleteObject")
		.map((entry) => entry.input.Key);

beforeEach(() => {
	sent.length = 0;
	listPages = [];
});

test("rejects an unsupported or oversized image before any storage call", async () => {
	expect(() => assertValidAvatarInput("image/gif", 10)).toThrow(
		AvatarValidationError
	);
	expect(() =>
		assertValidAvatarInput("image/png", 10 * 1024 * 1024 + 1)
	).toThrow("File size too large");
	expect(() => assertValidAvatarInput("image/webp", 1024)).not.toThrow();

	await expect(
		processAndUploadAvatar("user-1", Buffer.from("gif"), "image/gif")
	).rejects.toBeInstanceOf(AvatarValidationError);
	expect(sent).toHaveLength(0);
});

test("deletes exactly the displaced avatar set and nothing else", async () => {
	await deleteAvatarSet("user-1", "avatars/user-1/old");

	expect(deletedKeys()).toEqual([
		"avatars/user-1/old_32.webp",
		"avatars/user-1/old_64.webp",
		"avatars/user-1/old_128.webp",
		"avatars/user-1/old_256.webp",
	]);
	expect(sent.some((entry) => entry.kind === "ListObjectsV2")).toBe(false);
});

test("ignores a missing or foreign avatar id", async () => {
	await deleteAvatarSet("user-1", null);
	await deleteAvatarSet("user-1", "avatars/user-2/theirs");
	await deleteAvatarSet("user-1", "avatars/org/user-1/logo");

	expect(sent).toHaveLength(0);
});

test("deletes every page of the user's prefix", async () => {
	listPages = [
		[{ Key: "avatars/user-1/a_32.webp" }, { Key: "avatars/user-1/a_64.webp" }],
		[{ Key: "avatars/user-1/b_32.webp" }],
	];

	await deleteUserAvatarFiles("user-1");

	const lists = sent.filter((entry) => entry.kind === "ListObjectsV2");
	expect(lists.map((entry) => entry.input.ContinuationToken)).toEqual([
		undefined,
		"1",
	]);
	expect(deletedKeys()).toEqual([
		"avatars/user-1/a_32.webp",
		"avatars/user-1/a_64.webp",
		"avatars/user-1/b_32.webp",
	]);
});
