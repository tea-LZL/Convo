use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn validate_slash_command(cmd: &mut SlashCommandInput) -> Result<(), String> {
    let name = cmd.name.trim();
    cmd.name = name.strip_prefix('/').unwrap_or(name).to_owned();
    cmd.description = cmd
        .description
        .take()
        .map(|description| description.trim().to_owned());
    cmd.body = cmd.body.trim().to_owned();

    let mut name_bytes = cmd.name.bytes();
    let valid_first = matches!(name_bytes.next(), Some(b'a'..=b'z' | b'0'..=b'9'));
    let valid_remaining = name_bytes.all(|byte| {
        byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
    });
    if cmd.name.len() > 32 || !valid_first || !valid_remaining {
        return Err(
            "Slash command name must be 1-32 lowercase letters, numbers, underscores, or hyphens, starting with a letter or number".into(),
        );
    }
    if cmd
        .description
        .as_deref()
        .is_some_and(|description| description.chars().count() > 500)
    {
        return Err("Slash command description must be 500 characters or fewer".into());
    }
    if cmd.body.is_empty() {
        return Err("Slash command body cannot be empty".into());
    }
    if cmd.body.chars().count() > 100_000 {
        return Err("Slash command body must be 100,000 characters or fewer".into());
    }

    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SlashCommand {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub body: String,
    pub created_at: String,
}

#[tauri::command]
pub fn list_slash_commands(pool: State<'_, Arc<DbPool>>) -> Result<Vec<SlashCommand>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, description, body, created_at FROM slash_commands ORDER BY name")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(SlashCommand {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                body: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upsert_slash_command(
    pool: State<'_, Arc<DbPool>>,
    mut cmd: SlashCommandInput,
) -> Result<String, String> {
    validate_slash_command(&mut cmd)?;
    let conn = pool.get().map_err(|e| e.to_string())?;
    upsert_slash_command_in_connection(&conn, cmd)
}

fn upsert_slash_command_in_connection(
    conn: &rusqlite::Connection,
    cmd: SlashCommandInput,
) -> Result<String, String> {
    if let Some(id) = cmd.id {
        let updated = conn
            .execute(
                "UPDATE slash_commands SET name = ?1, description = ?2, body = ?3 WHERE id = ?4",
                params![cmd.name, cmd.description, cmd.body, &id],
            )
            .map_err(|e| e.to_string())?;
        if updated == 0 {
            return Err(format!("Slash command '{id}' was not found"));
        }
        return Ok(id);
    }

    let id = Uuid::new_v4().to_string();
    conn.query_row(
        "INSERT INTO slash_commands (id, name, description, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(name) DO UPDATE SET description = excluded.description, body = excluded.body
         RETURNING id",
        params![id, cmd.name, cmd.description, cmd.body, now()],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_slash_command(pool: State<'_, Arc<DbPool>>, id: String) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM slash_commands WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommandInput {
    pub id: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub body: String,
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::{upsert_slash_command_in_connection, validate_slash_command, SlashCommandInput};

    fn command() -> SlashCommandInput {
        SlashCommandInput {
            id: None,
            name: "summarize".into(),
            description: Some("Summarize the current conversation".into()),
            body: "Summarize the current conversation.".into(),
        }
    }

    fn validated(mut command: SlashCommandInput) -> SlashCommandInput {
        validate_slash_command(&mut command).unwrap();
        command
    }

    fn slash_commands_connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE slash_commands (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                description TEXT,
                body TEXT NOT NULL,
                created_at TEXT NOT NULL
            );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn normalizes_trimmed_command_values_and_leading_slash() {
        let mut command = command();
        command.name = "  /summarize  ".into();
        command.description = Some("  Summarize the current conversation  ".into());
        command.body = "  Summarize the current conversation.  ".into();

        validate_slash_command(&mut command).unwrap();

        assert_eq!(command.name, "summarize");
        assert_eq!(
            command.description.as_deref(),
            Some("Summarize the current conversation")
        );
        assert_eq!(command.body, "Summarize the current conversation.");
    }

    #[test]
    fn enforces_the_slash_command_name_pattern() {
        for name in ["a".to_string(), "a0_-".to_string(), "a".repeat(32)] {
            let mut command = command();
            command.name = name;
            assert!(validate_slash_command(&mut command).is_ok());
        }

        for name in [
            "".to_string(),
            "_summarize".to_string(),
            "-summarize".to_string(),
            "Summarize".to_string(),
            "summarize!".to_string(),
            "//summarize".to_string(),
            "a".repeat(33),
        ] {
            let mut command = command();
            command.name = name;
            let error = validate_slash_command(&mut command).unwrap_err();
            assert!(error.contains("name"), "unexpected error: {error}");
        }
    }

    #[test]
    fn rejects_a_blank_slash_command_body() {
        let mut command = command();
        command.body = " \n\t ".into();

        let error = validate_slash_command(&mut command).unwrap_err();

        assert!(error.contains("body"), "unexpected error: {error}");
    }

    #[test]
    fn enforces_slash_command_character_limits() {
        let mut maximum_lengths = command();
        maximum_lengths.description = Some("é".repeat(500));
        maximum_lengths.body = "界".repeat(100_000);
        assert!(validate_slash_command(&mut maximum_lengths).is_ok());

        let mut description_too_long = command();
        description_too_long.description = Some("é".repeat(501));
        let error = validate_slash_command(&mut description_too_long).unwrap_err();
        assert!(error.contains("description"), "unexpected error: {error}");

        let mut body_too_long = command();
        body_too_long.body = "界".repeat(100_001);
        let error = validate_slash_command(&mut body_too_long).unwrap_err();
        assert!(error.contains("body"), "unexpected error: {error}");
    }

    #[test]
    fn upsert_collision_returns_id_from_its_mutation_not_a_later_lookup() {
        let conn = slash_commands_connection();
        conn.execute(
            "INSERT INTO slash_commands (id, name, description, body, created_at)
             VALUES ('existing-id', 'summarize', 'Original summary', 'Original body', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.execute_batch(
            "CREATE TRIGGER replace_id_after_upsert
             AFTER UPDATE ON slash_commands
             WHEN OLD.id = 'existing-id'
             BEGIN
                UPDATE slash_commands SET id = 'changed-after-upsert' WHERE id = OLD.id;
             END;",
        )
        .unwrap();

        let id = upsert_slash_command_in_connection(
            &conn,
            validated(SlashCommandInput {
                id: None,
                name: "summarize".into(),
                description: Some("Updated summary".into()),
                body: "Updated body".into(),
            }),
        )
        .unwrap();

        assert_eq!(id, "existing-id");
        let persisted_id: String = conn
            .query_row(
                "SELECT id FROM slash_commands WHERE name = 'summarize'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(persisted_id, "changed-after-upsert");
    }

    #[test]
    fn upserts_duplicate_normalized_slash_command_names_into_one_row() {
        let conn = slash_commands_connection();
        let first_id = upsert_slash_command_in_connection(
            &conn,
            validated(SlashCommandInput {
                id: None,
                name: "  /summarize  ".into(),
                description: Some("  First summary  ".into()),
                body: "  First body  ".into(),
            }),
        )
        .unwrap();
        let second_id = upsert_slash_command_in_connection(
            &conn,
            validated(SlashCommandInput {
                id: None,
                name: "summarize".into(),
                description: Some("  Updated summary  ".into()),
                body: "  Updated body  ".into(),
            }),
        )
        .unwrap();

        assert_eq!(second_id, first_id);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM slash_commands", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        let persisted: (String, String, Option<String>, String) = conn
            .query_row(
                "SELECT id, name, description, body FROM slash_commands",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(persisted.0, first_id);
        assert_eq!(persisted.1, "summarize");
        assert_eq!(persisted.2.as_deref(), Some("Updated summary"));
        assert_eq!(persisted.3, "Updated body");
    }

    #[test]
    fn rejects_updates_for_unknown_ids_without_mutating_storage() {
        let conn = slash_commands_connection();
        let original_id = upsert_slash_command_in_connection(&conn, validated(command())).unwrap();
        let before: (String, String, Option<String>, String) = conn
            .query_row(
                "SELECT id, name, description, body FROM slash_commands",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();

        let error = upsert_slash_command_in_connection(
            &conn,
            validated(SlashCommandInput {
                id: Some("missing-id".into()),
                name: "renamed".into(),
                description: Some("Updated summary".into()),
                body: "Updated body".into(),
            }),
        )
        .unwrap_err();

        assert!(error.contains("not found"), "unexpected error: {error}");
        assert!(error.contains("missing-id"), "unexpected error: {error}");
        let after: (String, String, Option<String>, String) = conn
            .query_row(
                "SELECT id, name, description, body FROM slash_commands",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(before.0, original_id);
        assert_eq!(after, before);
    }

    #[test]
    fn updates_an_existing_slash_command_by_id_after_normalizing_values() {
        let conn = slash_commands_connection();
        conn.execute(
            "INSERT INTO slash_commands (id, name, description, body, created_at)
             VALUES ('existing-id', 'summarize', 'Original summary', 'Original body', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();

        let id = upsert_slash_command_in_connection(
            &conn,
            validated(SlashCommandInput {
                id: Some("existing-id".into()),
                name: "  /renamed  ".into(),
                description: Some("  Updated summary  ".into()),
                body: "  Updated body  ".into(),
            }),
        )
        .unwrap();

        assert_eq!(id, "existing-id");
        let persisted: (String, Option<String>, String) = conn
            .query_row(
                "SELECT name, description, body FROM slash_commands WHERE id = 'existing-id'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(persisted.0, "renamed");
        assert_eq!(persisted.1.as_deref(), Some("Updated summary"));
        assert_eq!(persisted.2, "Updated body");
    }
}
