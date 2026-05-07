use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::ollama::ChatMessage;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub model: String,
    pub created_at: String,
    pub updated_at: String,
    pub messages: Vec<ChatMessage>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Store {
    conversations: Vec<Conversation>,
}

fn store_path() -> PathBuf {
    let dir = dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("convo");
    fs::create_dir_all(&dir).ok();
    dir.join("conversations.json")
}

fn load_store() -> Store {
    let path = store_path();
    if path.exists() {
        let data = fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&data).unwrap_or(Store {
            conversations: vec![],
        })
    } else {
        Store {
            conversations: vec![],
        }
    }
}

fn save_store(store: &Store) -> Result<(), String> {
    let path = store_path();
    let data = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Failed to serialize: {}", e))?;
    fs::write(&path, data).map_err(|e| format!("Failed to write: {}", e))?;
    Ok(())
}

pub fn list_conversations() -> Result<Vec<Conversation>, String> {
    let store = load_store();
    let mut convs = store.conversations;
    convs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(convs)
}

pub fn create_conversation(title: String, model: String) -> Result<Conversation, String> {
    let mut store = load_store();
    let now = chrono::Utc::now().to_rfc3339();
    let conv = Conversation {
        id: uuid::Uuid::new_v4().to_string(),
        title,
        model,
        created_at: now.clone(),
        updated_at: now,
        messages: vec![],
    };
    store.conversations.push(conv.clone());
    save_store(&store)?;
    Ok(conv)
}

pub fn rename_conversation(id: &str, new_title: &str) -> Result<(), String> {
    let mut store = load_store();
    if let Some(conv) = store.conversations.iter_mut().find(|c| c.id == id) {
        conv.title = new_title.to_string();
        conv.updated_at = chrono::Utc::now().to_rfc3339();
        save_store(&store)?;
        Ok(())
    } else {
        Err("Conversation not found".into())
    }
}

pub fn delete_conversation(id: &str) -> Result<(), String> {
    let mut store = load_store();
    store.conversations.retain(|c| c.id != id);
    save_store(&store)?;
    Ok(())
}

pub fn get_conversation(id: &str) -> Result<Conversation, String> {
    let store = load_store();
    store
        .conversations
        .iter()
        .find(|c| c.id == id)
        .cloned()
        .ok_or_else(|| "Conversation not found".into())
}

pub fn save_messages(id: &str, messages: &[ChatMessage]) -> Result<(), String> {
    let mut store = load_store();
    if let Some(conv) = store.conversations.iter_mut().find(|c| c.id == id) {
        conv.messages = messages.to_vec();
        conv.updated_at = chrono::Utc::now().to_rfc3339();
        save_store(&store)?;
        Ok(())
    } else {
        Err("Conversation not found".into())
    }
}
