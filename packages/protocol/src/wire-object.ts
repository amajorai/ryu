import { z } from "zod";

const container = z.custom<object>((value) => {
	const wrapped = new Object(value);
	return (
		wrapped === value &&
		!Array.isArray(value) &&
		!z.function().safeParse(value).success
	);
});

/** Project declared fields, retaining legacy inherited fields and checking own keys. */
export function wireObject<T extends z.ZodRawShape>(fields: T, closed = false) {
	const keys = Object.keys(fields);
	return z.preprocess((input, context) => {
		const parsed = container.safeParse(input);
		if (
			!parsed.success ||
			(closed && !Object.keys(parsed.data).every((key) => keys.includes(key)))
		) {
			context.addIssue({
				code: "custom",
				message: "Expected an object with the declared public fields",
			});
			return z.NEVER;
		}
		const projected = {};
		for (const key of keys) {
			if (key in parsed.data) {
				Object.defineProperty(projected, key, {
					enumerable: true,
					get() {
						let owner: object | null = parsed.data;
						while (owner !== null) {
							const descriptor = Object.getOwnPropertyDescriptor(owner, key);
							if (descriptor) {
								return descriptor.get
									? descriptor.get.call(parsed.data)
									: descriptor.value;
							}
							owner = Object.getPrototypeOf(owner);
						}
						return undefined;
					},
				});
			}
		}
		return projected;
	}, z.object(fields));
}
