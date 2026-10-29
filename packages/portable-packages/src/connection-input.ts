import { z } from "zod";
import { nativeNumberSchema } from "./native-json.ts";
import type { PackageSerdeObject, PackageSerdeValue } from "./serde.ts";

const primitive = z.union([
	z.string(),
	z.boolean(),
	nativeNumberSchema,
	z.nan(),
	z.null(),
	z.undefined(),
]);
const container = z.custom<object>(
	(value) =>
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- This shallow admission predicate prevents recursive decoding of untrusted children.
		typeof value === "object" && value !== null && !Array.isArray(value)
);
const fields = [
	"provider",
	"toolkit",
	"id",
	"display_name",
	"displayName",
	"name",
	"label",
	"purpose",
	"required",
	"optional",
	"consumers",
	"declared_consumers",
	"declaredConsumers",
	"usage",
	"uses",
	"declared_usage",
	"declaredUsage",
	"kind",
	"type",
	"system_prompt",
	"descriptor",
	"metadata",
	"manifest",
	"connection_requirements",
	"connectionRequirements",
	"connections",
];

/** Preserve cyclic declaration graphs and own-key provenance for credential diagnostics. */
function decode(
	input: Parameters<typeof primitive.parse>[0],
	cache: Map<object, PackageSerdeValue>
): PackageSerdeValue {
	const scalar = primitive.safeParse(input);
	if (scalar.success) {
		return scalar.data;
	}
	if (Array.isArray(input)) {
		const cached = cache.get(input);
		if (cached !== undefined) {
			return cached;
		}
		const output: PackageSerdeValue[] = [];
		cache.set(input, output);
		for (const entry of input) {
			output.push(decode(entry, cache));
		}
		return output;
	}
	const object = container.safeParse(input);
	if (!object.success) {
		return Number.NaN;
	}
	const cached = cache.get(object.data);
	if (cached !== undefined) {
		return cached;
	}
	const output: PackageSerdeObject = {};
	const inherited: PackageSerdeObject = {};
	Object.setPrototypeOf(output, inherited);
	cache.set(object.data, output);
	for (const key of new Set([
		...Object.getOwnPropertyNames(object.data),
		...fields,
	])) {
		let owner: object | null = object.data;
		while (owner !== null) {
			const descriptor = Object.getOwnPropertyDescriptor(owner, key);
			if (descriptor) {
				const entry = descriptor.get
					? descriptor.get.call(object.data)
					: descriptor.value;
				Object.defineProperty(owner === object.data ? output : inherited, key, {
					enumerable: owner === object.data && descriptor.enumerable,
					configurable: true,
					value: decode(entry, cache),
				});
				break;
			}
			owner = Object.getPrototypeOf(owner);
		}
	}
	return output;
}
function admitted(
	input: Parameters<typeof primitive.parse>[0],
	seen: Set<object>
): boolean {
	if (primitive.safeParse(input).success) {
		return true;
	}
	if (Array.isArray(input)) {
		if (seen.has(input)) {
			return true;
		}
		seen.add(input);
		return input.every((entry) => admitted(entry, seen));
	}
	const object = container.safeParse(input);
	if (!object.success) {
		return false;
	}
	if (seen.has(object.data)) {
		return true;
	}
	seen.add(object.data);
	return Object.getOwnPropertyNames(object.data).every((key) =>
		admitted(Object.getOwnPropertyDescriptor(object.data, key)?.value, seen)
	);
}
const normalizedGraph = z.custom<PackageSerdeValue>((value) =>
	admitted(value, new Set())
);
export const connectionInputSchema = z.preprocess(
	(input) => decode(input, new Map()),
	normalizedGraph
);
export const connectionObjectSchema = z.custom<PackageSerdeObject>(
	// The input boundary already normalized the graph. Traversal checks only
	// the current node, avoiding repeated validation of every descendant.
	(value) => container.safeParse(value).success
);
