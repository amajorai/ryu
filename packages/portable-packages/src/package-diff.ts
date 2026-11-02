import { z } from "zod";
import { nativeJsonSchema, nativeNumberSchema } from "./native-json.ts";
import {
	bytesFromString,
	canonicalJson,
	digestFile,
	isSensitivePath,
	stringFromBytes,
	validatePackageManifest,
} from "./package-manifest.ts";
import {
	PACKAGE_MANIFEST_FILE,
	type PackageChange,
	type PackageTree,
	type PackageUpdateDiff,
	SECRETS_FILE,
} from "./package-types.ts";
import {
	type PackageSerdeObject,
	type PackageSerdeValue,
	packageSerdeObjectSchema,
	packageSerdeSchema,
} from "./serde.ts";

function equalBytes(
	left: Uint8Array | undefined,
	right: Uint8Array | undefined
): boolean {
	if (!(left && right) || left.byteLength !== right.byteLength) {
		return left === right;
	}
	for (let index = 0; index < left.byteLength; index++) {
		if (left[index] !== right[index]) {
			return false;
		}
	}
	return true;
}

function mergeJsonValue(
	base: PackageSerdeValue,
	local: PackageSerdeValue,
	upstream: PackageSerdeValue,
	path: string,
	conflicts: string[]
): PackageSerdeValue {
	if (canonicalJson(local) === canonicalJson(base)) {
		return upstream;
	}
	if (canonicalJson(upstream) === canonicalJson(base)) {
		return local;
	}
	if (canonicalJson(local) === canonicalJson(upstream)) {
		return local;
	}
	const baseObject = packageSerdeObjectSchema.safeParse(base);
	const localObject = packageSerdeObjectSchema.safeParse(local);
	const upstreamObject = packageSerdeObjectSchema.safeParse(upstream);
	if (baseObject.success && localObject.success && upstreamObject.success) {
		const keys = new Set([
			...Object.keys(baseObject.data),
			...Object.keys(localObject.data),
			...Object.keys(upstreamObject.data),
		]);
		const result: PackageSerdeObject = {};
		for (const key of [...keys].sort()) {
			const merged = mergeJsonValue(
				baseObject.data[key],
				localObject.data[key],
				upstreamObject.data[key],
				`${path}.${key}`,
				conflicts
			);
			if (merged !== undefined) {
				result[key] = merged;
			}
		}
		return result;
	}
	if (Array.isArray(base) && Array.isArray(local) && Array.isArray(upstream)) {
		const setLike = /(?:^|\.)?(?:tools|skills)$/.test(path);
		if (!setLike) {
			// Arrays such as workflow nodes and ordered rules carry meaning in their
			// position. Do not turn an ordered array into an object-keyed set merely
			// because its members happen to expose an id or name.
			conflicts.push(path);
			return local;
		}
		const arrayKey = (item: PackageSerdeValue): string | null => {
			const object = packageSerdeObjectSchema.safeParse(item);
			if (!object.success) {
				return null;
			}
			for (const key of ["id", "name", "key", "slug"]) {
				const text = z.string().safeParse(object.data[key]);
				if (text.success && text.data.length > 0) {
					return `${key}:${text.data}`;
				}
			}
			return null;
		};
		const keyed = [base, local, upstream].every((items) =>
			items.every((item) => arrayKey(item) !== null)
		);
		if (keyed) {
			const byId = (items: PackageSerdeValue[]) =>
				new Map(
					items.flatMap((item) => {
						const key = arrayKey(item);
						return key === null
							? []
							: [[key, item] satisfies [string, PackageSerdeValue]];
					})
				);
			const baseById = byId(base);
			const localById = byId(local);
			const upstreamById = byId(upstream);
			const ids = new Set([
				...baseById.keys(),
				...localById.keys(),
				...upstreamById.keys(),
			]);
			const result: PackageSerdeValue[] = [];
			for (const id of [...ids].sort()) {
				const merged = mergeJsonValue(
					baseById.get(id),
					localById.get(id),
					upstreamById.get(id),
					`${path}[${id}]`,
					conflicts
				);
				if (merged !== undefined) {
					result.push(merged);
				}
			}
			return result;
		}
		if (
			[base, local, upstream].every((items) =>
				items.every(
					(item) =>
						z
							.union([z.string(), nativeNumberSchema, z.nan(), z.boolean()])
							.safeParse(item).success
				)
			)
		) {
			// Tool and skill lists are set-like agent configuration. When both sides
			// add entries, preserve both additions instead of turning an otherwise
			// safe update into a conflict. Object arrays use stable ids/names above.
			const values = new Map<string, PackageSerdeValue>();
			for (const item of [...local, ...upstream]) {
				values.set(
					`${z.string().safeParse(item).success ? "string" : z.boolean().safeParse(item).success ? "boolean" : "number"}:${String(item)}`,
					item
				);
			}
			return [...values.values()].sort((left, right) =>
				String(left).localeCompare(String(right))
			);
		}
	}
	conflicts.push(path);
	return local;
}

function parseJsonFile(
	data: Uint8Array | undefined
): z.core.util.JSONType | undefined {
	if (!data) {
		return undefined;
	}
	try {
		return nativeJsonSchema.parse(JSON.parse(stringFromBytes(data)));
	} catch {
		return undefined;
	}
}

function mergeFile(
	path: string,
	base: Uint8Array | undefined,
	local: Uint8Array | undefined,
	upstream: Uint8Array | undefined,
	conflicts: string[]
): Uint8Array | undefined {
	if (isSensitivePath(path)) {
		// A credentials/secrets change is never auto-applied, even when the local
		// package did not edit that file. The caller must explicitly unlock and
		// resolve it outside the package update merge.
		if (!equalBytes(base, upstream)) {
			conflicts.push(path);
		}
		return local;
	}
	if (equalBytes(local, base)) {
		return upstream;
	}
	if (equalBytes(upstream, base) || equalBytes(local, upstream)) {
		return local;
	}
	if (path.endsWith(".json")) {
		const baseJson = parseJsonFile(base);
		const localJson = parseJsonFile(local);
		const upstreamJson = parseJsonFile(upstream);
		if (localJson !== undefined && upstreamJson !== undefined) {
			const merged = mergeJsonValue(
				baseJson,
				localJson,
				upstreamJson,
				path,
				conflicts
			);
			return bytesFromString(`${JSON.stringify(merged, null, 2)}\n`);
		}
	}
	conflicts.push(path);
	return local;
}

export function diffPackageTrees(
	base: PackageTree,
	local: PackageTree,
	upstream: PackageTree
): PackageUpdateDiff {
	const paths = new Set([
		...Object.keys(base.files),
		...Object.keys(local.files),
		...Object.keys(upstream.files),
	]);
	const changes: PackageChange[] = [];
	const conflicts: string[] = [];
	const mergedFiles: Record<string, Uint8Array> = {};
	for (const path of [...paths].sort()) {
		const baseFile = base.files[path];
		const localFile = local.files[path];
		const upstreamFile = upstream.files[path];
		const baseDigest = baseFile ? digestFile(baseFile) : null;
		const localDigest = localFile ? digestFile(localFile) : null;
		const upstreamDigest = upstreamFile ? digestFile(upstreamFile) : null;
		const changedLocal = !equalBytes(localFile, baseFile);
		const changedUpstream = !equalBytes(upstreamFile, baseFile);
		const secret = path === SECRETS_FILE || isSensitivePath(path);
		let status: PackageChange["status"] = "unchanged";
		if (secret && changedUpstream) {
			status = "conflict";
		} else if (!(changedLocal || changedUpstream)) {
			status = "unchanged";
		} else if (!changedLocal) {
			status = upstreamFile ? (baseFile ? "modified" : "added") : "removed";
		} else if (!changedUpstream || equalBytes(localFile, upstreamFile)) {
			status = localFile ? (baseFile ? "modified" : "added") : "removed";
		} else {
			status = "conflict";
		}
		changes.push({
			baseDigest,
			localDigest,
			path,
			secret,
			status,
			upstreamDigest,
		});
		const merged = mergeFile(
			path,
			baseFile,
			localFile,
			upstreamFile,
			conflicts
		);
		if (merged) {
			mergedFiles[path] = merged;
		}
	}
	const manifestConflicts: string[] = [];
	const mergedManifestValue = mergeJsonValue(
		packageSerdeSchema.parse(base.manifest),
		packageSerdeSchema.parse(local.manifest),
		packageSerdeSchema.parse(upstream.manifest),
		PACKAGE_MANIFEST_FILE,
		manifestConflicts
	);
	conflicts.push(...manifestConflicts);
	const mergedManifest =
		conflicts.length === 0
			? validatePackageManifest(mergedManifestValue)
			: local.manifest;
	return {
		changes,
		conflicts: [...new Set(conflicts)].sort(),
		merged:
			conflicts.length === 0
				? { files: mergedFiles, manifest: mergedManifest }
				: null,
	};
}
