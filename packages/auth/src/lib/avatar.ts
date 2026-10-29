import { randomUUID } from "node:crypto";
import {
	DeleteObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import sharp from "sharp";

const rawEndpoint = process.env.STORAGE_ENDPOINT;
const storageEndpoint = rawEndpoint?.startsWith("https://")
	? rawEndpoint
	: rawEndpoint
		? `https://${rawEndpoint}`
		: undefined;

const s3Client = new S3Client({
	region: process.env.STORAGE_REGION || "us-east-1",
	endpoint: storageEndpoint,
	credentials: {
		accessKeyId: process.env.STORAGE_ACCESS_KEY_ID || "",
		secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY || "",
	},
	forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === "true",
	followRegionRedirects: false,
});

const STORAGE_BUCKET_NAME = process.env.STORAGE_BUCKET_NAME || "ryu-avatars";

export const AVATAR_SIZES = {
	small: 32,
	medium: 64,
	large: 128,
	xlarge: 256,
} as const;

export interface AvatarUrls {
	large: string;
	medium: string;
	small: string;
	xlarge: string;
}

export interface ProcessedAvatar {
	avatarId: string;
	compressedSize: number;
	originalSize: number;
	urls: AvatarUrls;
	userId: string;
}

/**
 * Who an avatar belongs to. Originally this pipeline was user-only — the key
 * prefix, the param name, and the caller's DB write were all hardcoded to a
 * user. Orgs and teams upload the same way, so the owner is now explicit and
 * the S3 prefix is namespaced per type (`avatars/user/…`, `avatars/org/…`,
 * `avatars/team/…`) rather than colliding in one flat `avatars/{id}/` space.
 */
export type AvatarOwnerType = "user" | "org" | "team";

export async function processAndUploadAvatar(
	userId: string,
	imageBuffer: Buffer,
	mimeType: string
): Promise<ProcessedAvatar> {
	return processAndUploadOwnerAvatar("user", userId, imageBuffer, mimeType);
}

const ALLOWED_AVATAR_MIME_TYPES: readonly string[] = [
	"image/jpeg",
	"image/png",
	"image/webp",
];
const MAX_AVATAR_BYTES = 10 * 1024 * 1024;

/** A rejected avatar input: the caller's fault, never a storage failure. */
export class AvatarValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AvatarValidationError";
	}
}

/**
 * Validate an avatar before anything is uploaded or deleted. A replace must
 * check the new image first, so a rejected file can never cost the user the
 * avatar they already have.
 */
export function assertValidAvatarInput(mimeType: string, size: number): void {
	if (!ALLOWED_AVATAR_MIME_TYPES.includes(mimeType)) {
		throw new AvatarValidationError(
			"Invalid image type. Only JPEG, PNG, and WebP are allowed."
		);
	}
	if (size > MAX_AVATAR_BYTES) {
		throw new AvatarValidationError(
			"File size too large. Maximum size is 10MB."
		);
	}
}

/** Owner-scoped upload. {@link processAndUploadAvatar} is the user-only alias. */
export async function processAndUploadOwnerAvatar(
	ownerType: AvatarOwnerType,
	ownerId: string,
	imageBuffer: Buffer,
	mimeType: string
): Promise<ProcessedAvatar> {
	const userId = ownerId;
	assertValidAvatarInput(mimeType, imageBuffer.length);

	const originalSize = imageBuffer.length;
	// Legacy user avatars live at `avatars/{userId}/…` — keep that exact prefix
	// for users so existing objects and URLs stay valid, and namespace only the
	// new owner types.
	const prefix =
		ownerType === "user"
			? `avatars/${ownerId}`
			: `avatars/${ownerType}/${ownerId}`;
	const baseKey = `${prefix}/${randomUUID()}`;

	const urls: AvatarUrls = {
		small: "",
		medium: "",
		large: "",
		xlarge: "",
	};

	let totalCompressedSize = 0;

	for (const sizeName of [
		"small",
		"medium",
		"large",
		"xlarge",
	] satisfies (keyof AvatarUrls)[]) {
		const width = AVATAR_SIZES[sizeName];
		const processedBuffer = await sharp(imageBuffer)
			.resize(width, width, {
				fit: "cover",
				position: "center",
			})
			.webp({ quality: 85 })
			.toBuffer();

		const key = `${baseKey}_${width}.webp`;
		await uploadToS3(key, processedBuffer, "image/webp");
		urls[sizeName] = generatePublicUrl(key);
		totalCompressedSize += processedBuffer.length;
	}

	return {
		userId,
		urls,
		originalSize,
		compressedSize: totalCompressedSize,
		avatarId: baseKey,
	};
}

async function uploadToS3(
	key: string,
	buffer: Buffer,
	contentType: string
): Promise<void> {
	const command = new PutObjectCommand({
		Bucket: STORAGE_BUCKET_NAME,
		Key: key,
		Body: buffer,
		ContentType: contentType,
		CacheControl: "public, max-age=31536000",
		Metadata: {
			uploadedAt: new Date().toISOString(),
		},
	});
	await s3Client.send(command);
}

function generatePublicUrl(key: string): string {
	const endpoint = storageEndpoint;
	const bucketName = STORAGE_BUCKET_NAME;
	const region = process.env.STORAGE_REGION || "us-east-1";

	if (endpoint) {
		return `${endpoint}/${bucketName}/${key}`;
	}
	return `https://${bucketName}.s3.${region}.amazonaws.com/${key}`;
}

async function deleteAvatarObject(key: string): Promise<void> {
	await s3Client.send(
		new DeleteObjectCommand({ Bucket: STORAGE_BUCKET_NAME, Key: key })
	);
}

/**
 * Delete exactly one uploaded avatar set (every rendered width of `avatarId`).
 * A replace calls this with the avatar it displaced, after the new one is
 * stored and recorded, so concurrent uploads each remove only their own
 * predecessor and the final `avatarId` always keeps its files. Best-effort:
 * an id outside the user's legacy prefix is ignored, and failures are logged.
 */
export async function deleteAvatarSet(
	userId: string,
	avatarId: string | null | undefined
): Promise<void> {
	if (!avatarId?.startsWith(`avatars/${userId}/`)) {
		return;
	}
	try {
		for (const width of Object.values(AVATAR_SIZES)) {
			await deleteAvatarObject(`${avatarId}_${width}.webp`);
		}
	} catch (error) {
		console.warn(
			`Failed to delete avatar ${avatarId} for user ${userId}:`,
			error
		);
	}
}

/** Delete every avatar object under the user's prefix, across all list pages. */
export async function deleteUserAvatarFiles(userId: string): Promise<void> {
	try {
		let continuationToken: string | undefined;
		do {
			const response = await s3Client.send(
				new ListObjectsV2Command({
					Bucket: STORAGE_BUCKET_NAME,
					ContinuationToken: continuationToken,
					Prefix: `avatars/${userId}/`,
				})
			);
			for (const object of response.Contents ?? []) {
				if (object.Key) {
					await deleteAvatarObject(object.Key);
				}
			}
			continuationToken = response.IsTruncated
				? response.NextContinuationToken
				: undefined;
		} while (continuationToken);
	} catch (error) {
		console.warn(`Failed to delete avatar files for user ${userId}:`, error);
	}
}
