use super::discovery::DiscoveredModel;
use super::types::ChatRequest;
use super::{ChatResponseChunk, ModelInfo, ProbeOutcome, Provider, ProviderError, ProviderResult};
use async_trait::async_trait;
use futures_util::StreamExt;
use std::pin::Pin;

pub struct OpenAiCompatProvider {
    base_url: String,
    api_key: Option<String>,
    http: reqwest::Client,
}

impl OpenAiCompatProvider {
    pub fn new(base_url: String, api_key: Option<String>) -> Self {
        let http = reqwest::Client::builder().build().expect("reqwest client");
        Self {
            base_url,
            api_key,
            http,
        }
    }

    fn url(&self, path: &str) -> String {
        format!(
            "{}/{}",
            self.base_url.trim_end_matches('/'),
            path.trim_start_matches('/')
        )
    }

    fn auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if let Some(k) = &self.api_key {
            req.bearer_auth(k)
        } else {
            req
        }
    }
}

#[async_trait]
impl Provider for OpenAiCompatProvider {
    fn kind(&self) -> &'static str {
        "openai_compat"
    }
    fn base_url(&self) -> &str {
        &self.base_url
    }
    fn api_key(&self) -> Option<&str> {
        self.api_key.as_deref()
    }

    fn list_models<'a>(
        &'a self,
    ) -> Pin<Box<dyn std::future::Future<Output = ProviderResult<Vec<ModelInfo>>> + Send + 'a>>
    {
        Box::pin(async move {
            let resp = self
                .auth(self.http.get(self.url("v1/models")))
                .send()
                .await
                .map_err(|e| ProviderError::Http(e.to_string()))?;
            if !resp.status().is_success() {
                return Err(ProviderError::Api {
                    status: resp.status().as_u16(),
                    body: resp.text().await.unwrap_or_default(),
                });
            }
            let body: OpenAiModelsResponse = resp
                .json()
                .await
                .map_err(|e| ProviderError::Parse(e.to_string()))?;
            Ok(body
                .data
                .into_iter()
                .map(|m| ModelInfo {
                    name: m.id,
                    family: None,
                    parameter_size: None,
                    quantization: None,
                    context_length: None,
                    size_bytes: None,
                    supports_thinking: false,
                    supports_vision: false,
                })
                .collect())
        })
    }

    fn probe<'a>(&'a self) -> Pin<Box<dyn std::future::Future<Output = ProbeOutcome> + Send + 'a>> {
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

    fn chat_stream<'a>(
        &'a self,
        mut request: ChatRequest,
    ) -> Pin<
        Box<
            dyn std::future::Future<
                    Output = ProviderResult<
                        Pin<
                            Box<
                                dyn futures_util::Stream<Item = ProviderResult<ChatResponseChunk>>
                                    + Send,
                            >,
                        >,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            request.stream = true;
            let openai_req = OpenAiChatRequest::from(request);

            let resp = self
                .auth(self.http.post(self.url("v1/chat/completions")))
                .json(&openai_req)
                .send()
                .await
                .map_err(|e| ProviderError::Http(e.to_string()))?;
            if !resp.status().is_success() {
                let status = resp.status().as_u16();
                let body = resp.text().await.unwrap_or_default();
                return Err(ProviderError::Api { status, body });
            }
            let stream = resp.bytes_stream();
            let parsed = futures_util::stream::unfold(
                (stream, Vec::<u8>::new()),
                |(mut stream, mut buf)| async move {
                    loop {
                        if let Some((idx, separator_len)) = find_sse_boundary(&buf) {
                            let end = idx + separator_len;
                            let event: Vec<u8> = buf.drain(..end).collect();
                            let text = String::from_utf8_lossy(&event).to_string();
                            let data_lines: Vec<String> = text
                                .lines()
                                .filter_map(|l| {
                                    l.strip_prefix("data:").map(|s| s.trim().to_string())
                                })
                                .collect();
                            if data_lines.is_empty() {
                                continue;
                            }
                            let joined = data_lines.join("\n");
                            if joined.trim() == "[DONE]" {
                                return Some((
                                    Ok(ChatResponseChunk {
                                        message: None,
                                        done: true,
                                        done_reason: Some("stop".into()),
                                        prompt_eval_count: None,
                                        eval_count: None,
                                    }),
                                    (stream, buf),
                                ));
                            }
                            match parse_sse_payload(&joined) {
                                Ok(Some(conv)) => return Some((Ok(conv), (stream, buf))),
                                Ok(None) => continue,
                                Err(error) => {
                                    tracing::warn!(%error, "ignoring malformed OpenAI stream event");
                                    continue;
                                }
                            }
                        }
                        match stream.next().await {
                            Some(Ok(bytes)) => {
                                buf.extend_from_slice(&bytes);
                            }
                            Some(Err(e)) => {
                                return Some((
                                    Err(ProviderError::Stream(e.to_string())),
                                    (stream, buf),
                                ));
                            }
                            None => {
                                return None;
                            }
                        }
                    }
                },
            );
            Ok(Box::pin(parsed)
                as Pin<
                    Box<dyn futures_util::Stream<Item = ProviderResult<ChatResponseChunk>> + Send>,
                >)
        })
    }
}

fn find_sse_boundary(buf: &[u8]) -> Option<(usize, usize)> {
    if let Some(index) = buf.windows(4).position(|window| window == b"\r\n\r\n") {
        return Some((index, 4));
    }
    buf.windows(2)
        .position(|window| window == b"\n\n")
        .map(|index| (index, 2))
}

pub(crate) fn parse_sse_payload(data: &str) -> ProviderResult<Option<ChatResponseChunk>> {
    if data.trim() == "[DONE]" {
        return Ok(Some(ChatResponseChunk {
            message: None,
            done: true,
            done_reason: Some("stop".into()),
            prompt_eval_count: None,
            eval_count: None,
        }));
    }
    serde_json::from_str::<OpenAiChunk>(data)
        .map(|chunk| Some(chunk.into_internal()))
        .map_err(|e| ProviderError::Parse(e.to_string()))
}

#[derive(serde::Deserialize)]
struct OpenAiModelsResponse {
    data: Vec<OpenAiModelEntry>,
}

#[derive(serde::Deserialize)]
struct OpenAiModelEntry {
    id: String,
}

#[derive(serde::Serialize)]
struct OpenAiChatRequest {
    model: String,
    messages: Vec<OpenAiMessage>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top_p: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stop: Option<Vec<String>>,
}

#[derive(serde::Serialize)]
struct OpenAiMessage {
    role: String,
    content: serde_json::Value,
}

impl From<ChatRequest> for OpenAiChatRequest {
    fn from(r: ChatRequest) -> Self {
        let mut messages: Vec<OpenAiMessage> = Vec::with_capacity(r.messages.len() + 1);
        if let Some(sys) = r.system.as_ref().filter(|s| !s.is_empty()) {
            messages.push(OpenAiMessage {
                role: "system".into(),
                content: serde_json::Value::String(sys.clone()),
            });
        }
        for m in r.messages {
            let content = if m.images.is_empty() {
                serde_json::Value::String(m.content)
            } else {
                let mut parts = vec![serde_json::json!({
                    "type": "text",
                    "text": m.content,
                })];
                parts.extend(m.images.into_iter().map(|image| {
                    let url = if image.starts_with("data:") {
                        image
                    } else {
                        format!("data:image/png;base64,{}", image)
                    };
                    serde_json::json!({
                        "type": "image_url",
                        "image_url": { "url": url },
                    })
                }));
                serde_json::Value::Array(parts)
            };
            messages.push(OpenAiMessage {
                role: m.role,
                content,
            });
        }
        Self {
            model: r.model,
            messages,
            stream: true,
            temperature: r.temperature,
            top_p: r.top_p,
            stop: r.stop,
        }
    }
}

#[derive(serde::Deserialize)]
struct OpenAiChunk {
    choices: Vec<OpenAiChoice>,
    #[serde(default, rename = "usage")]
    usage: Option<OpenAiUsage>,
}

#[derive(serde::Deserialize)]
struct OpenAiChoice {
    delta: OpenAiDelta,
    #[serde(default, rename = "finish_reason")]
    finish_reason: Option<String>,
}

#[derive(serde::Deserialize, Default)]
struct OpenAiDelta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    reasoning_content: Option<String>,
    #[serde(default)]
    reasoning: Option<String>,
}

#[derive(serde::Deserialize)]
struct OpenAiUsage {
    #[serde(default, rename = "prompt_tokens")]
    prompt_tokens: Option<u32>,
    #[serde(default, rename = "completion_tokens")]
    completion_tokens: Option<u32>,
}

impl OpenAiChunk {
    fn into_internal(self) -> ChatResponseChunk {
        let (content, thinking, done, done_reason) = match self.choices.first() {
            Some(c) => {
                let content = c.delta.content.clone().unwrap_or_default();
                let thinking = c
                    .delta
                    .reasoning_content
                    .clone()
                    .or_else(|| c.delta.reasoning.clone());
                let done = c.finish_reason.is_some();
                (content, thinking, done, c.finish_reason.clone())
            }
            None => (String::new(), None, true, Some("stop".into())),
        };
        ChatResponseChunk {
            message: if content.is_empty() && thinking.is_none() {
                None
            } else {
                Some(crate::providers::MessageContent {
                    role: "assistant".into(),
                    content,
                    thinking,
                    images: vec![],
                })
            },
            done,
            done_reason,
            prompt_eval_count: self.usage.as_ref().and_then(|u| u.prompt_tokens),
            eval_count: self.usage.as_ref().and_then(|u| u.completion_tokens),
        }
    }
}
