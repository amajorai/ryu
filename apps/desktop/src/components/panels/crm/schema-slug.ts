// Slugs for CRM objects and fields, derived from the name the user types.
//
// The store only accepts `^[a-z][a-z0-9_]{0,63}$` minus a few reserved words
// (`is_valid_slug` in crm/backend/src/models.rs). That alphabet is a deliberate
// SQL-injection guard, so a slug can never keep Unicode letters. A Japanese,
// Russian or Arabic name used to slug to nothing and leave Create disabled;
// such a name now gets a stable ASCII slug derived from a hash of the name.

const MAX_SLUG_LENGTH = 48;

/** Mirrors `RESERVED_SLUGS` in crm/backend/src/models.rs. */
const RESERVED_SLUGS: ReadonlySet<string> = new Set([
	"id",
	"object_id",
	"title",
	"created_at",
	"updated_at",
	"deleted_at",
	"record_id",
	"rowid",
]);

function trimUnderscores(text: string): string {
	return text.replace(/^_+|_+$/g, "");
}

/** The ASCII letters and digits of a name, lowercased and joined by `_`. Empty
 *  when the name has none. */
export function slugify(name: string): string {
	return trimUnderscores(
		name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
	).slice(0, MAX_SLUG_LENGTH);
}

/** FNV-1a over the name's UTF-16 units, in base 36: the same name always gets
 *  the same slug, so the slug shown while typing is the one created. */
function nameHash(name: string): string {
	let hash = 0x81_1c_9d_c5;
	for (let index = 0; index < name.length; index += 1) {
		hash ^= name.charCodeAt(index);
		hash = Math.imul(hash, 0x01_00_01_93);
	}
	return (hash >>> 0).toString(36);
}

/** A slug the store accepts for a new object or field, or `""` when the name
 *  has no letters or digits at all. */
export function schemaSlug(name: string, kind: "field" | "object"): string {
	const ascii = slugify(name);
	if (ascii === "") {
		const trimmed = name.trim().normalize("NFC");
		return /[\p{L}\p{N}]/u.test(trimmed) ? `${kind}_${nameHash(trimmed)}` : "";
	}
	const slug = /^[a-z]/.test(ascii)
		? ascii
		: trimUnderscores(`${kind}_${ascii}`.slice(0, MAX_SLUG_LENGTH));
	return RESERVED_SLUGS.has(slug) ? `${slug}_${kind}` : slug;
}

/** The plural to store when the user leaves "Name (many)" empty. The English
 *  `s` is only added to a Latin-script name; any other script keeps the name. */
export function defaultPlural(singular: string): string {
	const name = singular.trim();
	return /^[\p{Script=Latin}\p{N}\s'.&-]*\p{Script=Latin}$/u.test(name)
		? `${name}s`
		: name;
}
