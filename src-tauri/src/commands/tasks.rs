use crate::db::models::Task;
use rusqlite::params;
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[tauri::command]
pub fn list_tasks(pool: State<'_, Arc<DbPool>>) -> Result<Vec<Task>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, title, body, due_at, completed_at, priority, session_id, created_at
             FROM tasks ORDER BY (completed_at IS NULL) DESC, priority DESC, due_at ASC, created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Task {
                id: row.get(0)?,
                title: row.get(1)?,
                body: row.get(2)?,
                due_at: row.get(3)?,
                completed_at: row.get(4)?,
                priority: row.get(5)?,
                session_id: row.get(6)?,
                created_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upsert_task(pool: State<'_, Arc<DbPool>>, task: TaskInput) -> Result<String, String> {
    validate_task(&task)?;
    let is_update = task.id.is_some();
    let id = task.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let conn = pool.get().map_err(|e| e.to_string())?;
    if is_update {
        conn.execute(
            "UPDATE tasks SET title = ?1, body = ?2, due_at = ?3, completed_at = ?4, priority = ?5 WHERE id = ?6",
            params![task.title, task.body, task.due_at, task.completed_at, task.priority, id],
        )
        .map_err(|e| e.to_string())?;
    } else {
        conn.execute(
            "INSERT INTO tasks (id, title, body, due_at, completed_at, priority, session_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, task.title, task.body, task.due_at, task.completed_at, task.priority, task.session_id, now()],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(id)
}

fn validate_task(task: &TaskInput) -> Result<(), String> {
    if task.title.trim().is_empty() {
        return Err("Task title cannot be empty".into());
    }
    if task.title.len() > 500 {
        return Err("Task title is too long".into());
    }
    if task.body.as_deref().map(str::len).unwrap_or(0) > 2_000_000 {
        return Err("Task body is too large".into());
    }
    if !(0..=3).contains(&task.priority) {
        return Err("Task priority must be between 0 and 3".into());
    }
    Ok(())
}

#[tauri::command]
pub fn delete_task(pool: State<'_, Arc<DbPool>>, id: String) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM tasks WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn complete_task(
    pool: State<'_, Arc<DbPool>>,
    id: String,
    completed: bool,
) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let val = if completed { Some(now()) } else { None };
    conn.execute(
        "UPDATE tasks SET completed_at = ?1 WHERE id = ?2",
        params![val, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInput {
    pub id: Option<String>,
    pub title: String,
    pub body: Option<String>,
    pub due_at: Option<String>,
    pub completed_at: Option<String>,
    pub priority: i64,
    pub session_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::{validate_task, TaskInput};

    fn task() -> TaskInput {
        TaskInput {
            id: None,
            title: "Task".into(),
            body: Some("Details".into()),
            due_at: Some("2026-08-10".into()),
            completed_at: None,
            priority: 2,
            session_id: None,
        }
    }

    #[test]
    fn validates_task_fields() {
        assert!(validate_task(&task()).is_ok());
        let mut empty = task();
        empty.title = " ".into();
        assert!(validate_task(&empty).is_err());
        let mut bad_priority = task();
        bad_priority.priority = 4;
        assert!(validate_task(&bad_priority).is_err());
    }
}
