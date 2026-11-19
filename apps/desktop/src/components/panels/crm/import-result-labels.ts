/** A keyed word sense (`en-messages-senses*.ts`) with its English fallback. */
export type SenseMessage = (id: string, fallback: string) => string;

/**
 * The import result's "Created" and "Updated" counts, read through the keyed
 * `import.created` and `import.updated` (ja 作成, 更新): the bare catalog words
 * are date columns (ja 作成日時, 更新日).
 */
export function importResultLabels(sense: SenseMessage): {
	created: string;
	updated: string;
} {
	return {
		created: sense("import.created", "Created"),
		updated: sense("import.updated", "Updated"),
	};
}
