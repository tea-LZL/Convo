use super::types::ChatRequest;
use super::{
    ChatResponseChunk, ModelInfo, ProbeFuture, ProbeOutcome, Provider, ProviderError,
    ProviderFuture, ProviderResult, ProviderStream,
};
use async_trait::async_trait;
use futures_util::StreamExt;
use tokio::io::AsyncBufReadExt;
use tokio_stream::wrappers::LinesStream;

use super::discovery::DiscoveredModel;

pub struct OllamaProvider {
    base_url: String,
    http: reqwest::Client,
}

impl OllamaProvider {
    pub fn new(base_url: String, _api_key: Option<String>) -> Self {
        let http = reqwest::Client::builder().build().expect("reqwest client");
        Self { base_url, http }
    }

    fn url(&self, path: &str) -> String {
        format!("{}/{}", self.base_url.trim_end_matches('/'), path)
    }
}

#[async_trait]
impl Provider for OllamaProvider {
    fn list_models<'a>(&'a self) -> ProviderFuture<'a, Vec<ModelInfo>> {
        Box::pin(async move {
            let resp = self
                .http
                .get(self.url("api/tags"))
                .send()
                .await
                .map_err(|e| ProviderError::Http(e.to_string()))?;
            if !resp.status().is_success() {
                return Err(ProviderError::Api {
                    status: resp.status().as_u16(),
                    body: resp.text().await.unwrap_or_default(),
                });
            }
            let body: OllamaTagsResponse = resp
                .json()
                .await
                .map_err(|e| ProviderError::Parse(e.to_string()))?;
            let mut out = Vec::with_capacity(body.models.len());
            for m in body.models {
                out.push(ModelInfo {
                    name: m.name,
                    family: m.details.as_ref().and_then(|d| d.family.clone()),
                    parameter_size: m.details.as_ref().and_then(|d| d.parameter_size.clone()),
                    quantization: m
                        .details
                        .as_ref()
                        .and_then(|d| d.quantization_level.clone()),
                    context_length: None,
                    size_bytes: Some(m.size),
                    supports_thinking: false,
                    supports_vision: false,
                });
            }
            Ok(out)
        })
    }

    fn probe<'a>(&'a self) -> ProbeFuture<'a> {
        Box::pin(async move {
            match self.list_models().await {
                Ok(models) => {
                    let discovered: Vec<DiscoveredModel> = models
                        .into_iter()
                        .map(|m| DiscoveredModel {
                            id: m.name.clone(),
                            name: m.name,
                            context_length: m.context_length,
                        })
                        .collect();
                    ProbeOutcome::Ok(discovered)
                }
                Err(e) => ProbeOutcome::Err(format!("Probe failed: {}", e)),
            }
        })
    }

    fn chat_stream<'a>(&'a self, request: ChatRequest) -> ProviderFuture<'a, ProviderStream> {
        Box::pin(async move {
            let resp = self
                .http
                .post(self.url("api/chat"))
                .json(&request)
                .send()
                .await
                .map_err(|e| ProviderError::Http(e.to_string()))?;
            if !resp.status().is_success() {
                let status = resp.status().as_u16();
                let body = resp.text().await.unwrap_or_default();
                return Err(ProviderError::Api { status, body });
            }
            let stream = resp.bytes_stream();
            let reader =
                tokio_util::io::StreamReader::new(stream.map(|r| r.map_err(std::io::Error::other)));
            let buf = tokio::io::BufReader::new(reader);
            let lines = LinesStream::new(buf.lines());
            let parsed = lines.filter_map(|line| async move {
                match line {
                    Ok(l) => match parse_ollama_line(&l) {
                        Ok(chunk) => chunk.map(Ok),
                        Err(error) => {
                            tracing::warn!(%error, "ignoring malformed Ollama stream line");
                            None
                        }
                    },
                    Err(e) => Some(Err(ProviderError::Stream(e.to_string()))),
                }
            });
            Ok(Box::pin(parsed) as ProviderStream)
        })
    }
}

pub(crate) fn parse_ollama_line(line: &str) -> ProviderResult<Option<ChatResponseChunk>> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    serde_json::from_str::<ChatResponseChunk>(trimmed)
        .map(Some)
        .map_err(|e| ProviderError::Parse(e.to_string()))
}

#[derive(serde::Deserialize)]
struct OllamaTagsResponse {
    models: Vec<OllamaModelEntry>,
}

#[derive(serde::Deserialize)]
struct OllamaModelEntry {
    name: String,
    size: u64,
    details: Option<OllamaModelDetails>,
}

#[derive(serde::Deserialize)]
struct OllamaModelDetails {
    family: Option<String>,
    #[serde(rename = "parameter_size")]
    parameter_size: Option<String>,
    #[serde(rename = "quantization_level")]
    quantization_level: Option<String>,
}

pub async fn fetch_running_models(
    base_url: &str,
) -> Result<Vec<super::super::db::models::RunningModel>, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/api/ps", base_url.trim_end_matches('/'));
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Ollama: {}", e))?;
    let body: RunningModelsResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse: {}", e))?;
    Ok(body.models)
}

pub async fn fetch_models(
    base_url: &str,
) -> Result<Vec<super::super::db::models::OllamaModel>, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/api/tags", base_url.trim_end_matches('/'));
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Ollama: {}", e))?;
    let body: ModelsResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse: {}", e))?;
    Ok(body.models)
}

pub async fn fetch_context_length(base_url: &str, model: &str) -> Result<u32, String> {
    let client = reqwest::Client::new();
    let url = format!("{}/api/show", base_url.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "model": model }))
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Ollama: {}", e))?;
    let body: ShowModelResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse: {}", e))?;
    Ok(body.model_info.context_length.unwrap_or(8192))
}

#[derive(serde::Deserialize)]
struct ModelsResponse {
    models: Vec<super::super::db::models::OllamaModel>,
}

#[derive(serde::Deserialize)]
struct ShowModelResponse {
    #[serde(rename = "model_info")]
    model_info: ShowModelInfo,
}

#[derive(serde::Deserialize)]
struct ShowModelInfo {
    #[serde(rename = "context_length")]
    context_length: Option<u32>,
}

#[derive(serde::Deserialize)]
struct RunningModelsResponse {
    models: Vec<super::super::db::models::RunningModel>,
}
