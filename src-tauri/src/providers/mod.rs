pub mod discovery;
pub mod ollama;
pub mod openai_compat;
pub mod types;

use async_trait::async_trait;
use futures_util::Stream;
use serde::{Deserialize, Serialize};
use std::pin::Pin;
use thiserror::Error;
use tokio::sync::mpsc;

pub use types::{ChatRequest, ChatResponseChunk, MessageContent};

use crate::services::{DiscoveredModel, ProbeResult};

#[derive(Debug, Error)]
pub enum ProviderError {
    #[error("HTTP error: {0}")]
    Http(String),
    #[error("Parse error: {0}")]
    Parse(String),
    #[error("Stream error: {0}")]
    Stream(String),
    #[error("API error ({status}): {body}")]
    Api { status: u16, body: String },
    #[error("Not configured: {0}")]
    NotConfigured(String),
}

impl From<ProviderError> for String {
    fn from(e: ProviderError) -> Self {
        e.to_string()
    }
}

pub type ProviderResult<T> = Result<T, ProviderError>;

#[async_trait]
pub trait Provider: Send + Sync {
    fn kind(&self) -> &'static str;
    fn base_url(&self) -> &str;
    fn api_key(&self) -> Option<&str>;

    fn list_models<'a>(
        &'a self,
    ) -> Pin<Box<dyn std::future::Future<Output = ProviderResult<Vec<ModelInfo>>> + Send + 'a>>;
    fn probe<'a>(
        &'a self,
    ) -> Pin<Box<dyn std::future::Future<Output = ProbeOutcome> + Send + 'a>>;
    fn chat_stream<'a>(
        &'a self,
        request: ChatRequest,
    ) -> Pin<
        Box<
            dyn std::future::Future<
                    Output = ProviderResult<
                        Pin<Box<dyn Stream<Item = ProviderResult<ChatResponseChunk>> + Send>>,
                    >,
                > + Send
                + 'a,
        >,
    >;
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModelInfo {
    pub name: String,
    pub family: Option<String>,
    pub parameter_size: Option<String>,
    pub quantization: Option<String>,
    pub context_length: Option<u32>,
    pub size_bytes: Option<u64>,
    pub supports_thinking: bool,
    pub supports_vision: bool,
}

pub async fn probe(
    kind: &str,
    base_url: &str,
    api_key: Option<&str>,
) -> Result<ProbeResult, String> {
    let p: Box<dyn Provider> = match kind {
        "ollama" => Box::new(ollama::OllamaProvider::new(base_url.to_string(), None)),
        "openai_compat" => Box::new(openai_compat::OpenAiCompatProvider::new(
            base_url.to_string(),
            api_key.map(|s| s.to_string()),
        )),
        other => return Err(format!("Unknown provider kind: {}", other)),
    };
    match p.probe().await {
        ProbeOutcome::Ok(models) => Ok(ProbeResult {
            ok: true,
            message: "Connected".into(),
            models,
        }),
        ProbeOutcome::Err(msg) => Ok(ProbeResult {
            ok: false,
            message: msg,
            models: vec![],
        }),
    }
}

pub enum ProbeOutcome {
    Ok(Vec<crate::services::DiscoveredModel>),
    Err(String),
}

/// Spawn a stream into a Tauri-style mpsc channel that the Tauri command loop
/// can `recv()` on to emit events.
pub fn channelize<S>(stream: S) -> (mpsc::Receiver<ProviderResult<ChatResponseChunk>>, tokio::task::JoinHandle<()>)
where
    S: Stream<Item = ProviderResult<ChatResponseChunk>> + Send + Unpin + 'static,
{
    let (tx, rx) = mpsc::channel::<ProviderResult<ChatResponseChunk>>(64);
    let handle = tokio::spawn(async move {
        use futures_util::StreamExt;
        let mut s = stream;
        while let Some(item) = s.next().await {
            if tx.send(item).await.is_err() {
                break;
            }
        }
    });
    (rx, handle)
}
