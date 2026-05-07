use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OllamaModel {
    pub name: String,
    pub size: u64,
    pub modified_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ListModelsResponse {
    pub models: Vec<OllamaModel>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(rename = "promptTokens", default, skip_serializing_if = "Option::is_none")]
    pub prompt_tokens: Option<u32>,
    #[serde(rename = "outputTokens", default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u32>,
    #[serde(rename = "completedAt", default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub stream: bool,
}

#[derive(Debug, Deserialize)]
pub struct ChatResponseChunk {
    pub message: Option<MessageContent>,
    pub done: bool,
    #[serde(rename = "done_reason")]
    #[allow(dead_code)]
    pub done_reason: Option<String>,
    #[serde(rename = "prompt_eval_count", default)]
    pub prompt_eval_count: Option<u32>,
    #[serde(rename = "eval_count", default)]
    pub eval_count: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct MessageContent {
    pub content: String,
    #[serde(default)]
    pub thinking: Option<String>,
}

pub async fn list_models() -> Result<Vec<OllamaModel>, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get("http://localhost:11434/api/tags")
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Ollama: {}", e))?;

    let body: ListModelsResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    Ok(body.models)
}

#[derive(Debug, Deserialize)]
pub struct ModelInfo {
    #[serde(rename = "context_length")]
    pub context_length: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct ShowModelResponse {
    #[serde(rename = "model_info")]
    pub model_info: ModelInfo,
}

pub async fn get_model_context_length(model: String) -> Result<u32, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post("http://localhost:11434/api/show")
        .json(&serde_json::json!({ "model": model }))
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Ollama: {}", e))?;

    let body: ShowModelResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    Ok(body.model_info.context_length.unwrap_or(8192))
}

pub async fn chat_stream(
    model: String,
    messages: Vec<ChatMessage>,
) -> Result<reqwest::Response, String> {
    let client = reqwest::Client::new();
    let request = ChatRequest {
        model,
        messages,
        stream: true,
    };

    let resp = client
        .post("http://localhost:11434/api/chat")
        .json(&request)
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Ollama: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Ollama error {}: {}", status, body));
    }

    Ok(resp)
}
