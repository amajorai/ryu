//! A durable identity for each incarnation of a caller-chosen conversation ID.
use rusqlite::{Connection, OptionalExtension};

pub fn initialize(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS conversation_generations (
             conversation_id TEXT PRIMARY KEY,
             generation TEXT NOT NULL UNIQUE
         );
         CREATE TRIGGER IF NOT EXISTS conversation_generation_insert
         AFTER INSERT ON conversations BEGIN
             INSERT INTO conversation_generations (conversation_id, generation)
             VALUES (NEW.id, lower(hex(randomblob(16))));
         END;
         CREATE TRIGGER IF NOT EXISTS conversation_generation_delete
         AFTER DELETE ON conversations BEGIN
             DELETE FROM conversation_generations WHERE conversation_id = OLD.id;
         END;
         INSERT OR IGNORE INTO conversation_generations (conversation_id, generation)
         SELECT id, lower(hex(randomblob(16))) FROM conversations;",
    )
}

pub fn generation(
    connection: &Connection,
    conversation_id: &str,
) -> rusqlite::Result<Option<String>> {
    connection
        .query_row(
            "SELECT generation FROM conversation_generations WHERE conversation_id = ?1",
            [conversation_id],
            |row| row.get(0),
        )
        .optional()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn updates_preserve_identity_but_deleted_ids_and_imported_timestamps_do_not() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE conversations (id TEXT PRIMARY KEY, created_at INTEGER, owner TEXT); INSERT INTO conversations VALUES ('chat', 1, 'old-owner');").unwrap();
        initialize(&connection).unwrap();
        let old = generation(&connection, "chat").unwrap().unwrap();
        connection
            .execute(
                "UPDATE conversations SET owner = 'same-owner' WHERE id = 'chat'",
                [],
            )
            .unwrap();
        assert_eq!(
            generation(&connection, "chat").unwrap().as_deref(),
            Some(old.as_str())
        );
        connection
            .execute("DELETE FROM conversations WHERE id = 'chat'", [])
            .unwrap();
        assert!(generation(&connection, "chat").unwrap().is_none());
        connection
            .execute(
                "INSERT INTO conversations VALUES ('chat', 1, 'new-owner')",
                [],
            )
            .unwrap();
        assert_ne!(generation(&connection, "chat").unwrap().unwrap(), old);
        initialize(&connection).unwrap();
        assert!(generation(&connection, "chat").unwrap().is_some());
    }
}
