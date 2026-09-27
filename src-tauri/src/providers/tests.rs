use crate::providers::ollama::parse_ollama_line;
use crate::providers::ollama::OllamaProvider;
use crate::providers::openai_compat::parse_sse_payload;
use crate::providers::openai_compat::OpenAiCompatProvider;
use crate::providers::types::ChatResponseChunk;
use crate::providers::types::{ChatRequest, MessageContent};
use crate::providers::{probe, Provider, ProviderError};
use futures_util::StreamExt;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

#[test]
fn ollama_chunk_fixture_preserves_content_thinking_and_usage() {
    let chunk: ChatResponseChunk = serde_json::from_str(
            r#"{"message":{"role":"assistant","content":"hello","thinking":"reason"},"done":true,"prompt_eval_count":4,"eval_count":2}"#,
        )
        .unwrap();
    assert_eq!(chunk.message.unwrap().content, "hello");
    assert_eq!(chunk.prompt_eval_count, Some(4));
    assert_eq!(chunk.eval_count, Some(2));
}

#[test]
fn ollama_fixture_skips_empty_lines_and_reports_malformed_input() {
    assert!(parse_ollama_line("  ").unwrap().is_none());
    assert!(parse_ollama_line("not-json").is_err());
    assert_eq!(
        parse_ollama_line(r#"{"message":{"role":"assistant","content":"next"}}"#)
            .unwrap()
            .unwrap()
            .message
            .unwrap()
            .content,
        "next"
    );
}

#[test]
fn openai_sse_fixture_preserves_content_and_usage() {
    let chunk = parse_sse_payload(
            r#"{"choices":[{"delta":{"content":"hello"},"finish_reason":null}],"usage":{"prompt_tokens":4,"completion_tokens":2}}"#,
        )
        .unwrap()
        .unwrap();
    assert_eq!(chunk.message.unwrap().content, "hello");
    assert_eq!(chunk.prompt_eval_count, Some(4));
    assert_eq!(chunk.eval_count, Some(2));
}

#[test]
fn openai_sse_fixture_maps_reasoning_and_done() {
    let thinking = parse_sse_payload(
        r#"{"choices":[{"delta":{"reasoning_content":"think"},"finish_reason":null}]}"#,
    )
    .unwrap()
    .unwrap();
    assert_eq!(thinking.message.unwrap().thinking.as_deref(), Some("think"));

    let done = parse_sse_payload("[DONE]").unwrap().unwrap();
    assert!(done.done);
    assert_eq!(done.done_reason.as_deref(), Some("stop"));
}

#[test]
fn openai_sse_fixture_rejects_malformed_payload_for_stream_filter() {
    assert!(parse_sse_payload("not-json").is_err());
}

async fn serve_once(status: &str, body: &str, content_type: &str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let response = format!(
        "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        content_type,
        body.len(),
        body,
    );
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0_u8; 4096];
        let _ = socket.read(&mut request).await;
        socket.write_all(response.as_bytes()).await.unwrap();
    });
    format!("http://{}", address)
}

#[tokio::test]
async fn adapters_preserve_http_status_errors() {
    let ollama_url = serve_once("401 Unauthorized", "nope", "text/plain").await;
    let ollama = OllamaProvider::new(ollama_url, None);
    let error = ollama.list_models().await.unwrap_err();
    assert!(matches!(error, ProviderError::Api { status: 401, .. }));

    let openai_url = serve_once("500 Internal Server Error", "failed", "text/plain").await;
    let openai = OpenAiCompatProvider::new(openai_url, None);
    let error = openai.list_models().await.unwrap_err();
    assert!(matches!(error, ProviderError::Api { status: 500, .. }));
}

#[tokio::test]
async fn openai_adapter_handles_sse_reasoning_malformed_lines_and_eof() {
    let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"},\"finish_reason\":null}]}\r\n\r\n",
            "data: not-json\r\n\r\n",
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"think\"},\"finish_reason\":null}]}\n\n",
            "data: [DONE]\n\n",
        );
    let url = serve_once("200 OK", body, "text/event-stream").await;
    let provider = OpenAiCompatProvider::new(url, None);
    let mut stream = provider
        .chat_stream(ChatRequest {
            model: "model".into(),
            messages: vec![MessageContent {
                role: "user".into(),
                content: "hello".into(),
                thinking: None,
                images: vec![],
            }],
            stream: true,
            system: None,
            temperature: None,
            top_p: None,
            top_k: None,
            num_ctx: None,
            repeat_penalty: None,
            stop: None,
        })
        .await
        .unwrap();
    let mut chunks = Vec::new();
    while let Some(chunk) = stream.next().await {
        chunks.push(chunk.unwrap());
    }
    assert_eq!(chunks.len(), 3);
    assert_eq!(chunks[0].message.as_ref().unwrap().content, "hello");
    assert_eq!(
        chunks[1].message.as_ref().unwrap().thinking.as_deref(),
        Some("think")
    );
    assert!(chunks[2].done);
}

#[tokio::test]
async fn ollama_adapter_handles_thinking_and_eof_without_done_chunk() {
    let body = concat!(
        "{\"message\":{\"role\":\"assistant\",\"content\":\"hello\",\"thinking\":\"think\"}}\n",
        "not-json\n",
    );
    let url = serve_once("200 OK", body, "application/x-ndjson").await;
    let provider = OllamaProvider::new(url, None);
    let mut stream = provider
        .chat_stream(ChatRequest {
            model: "model".into(),
            messages: vec![],
            stream: true,
            system: None,
            temperature: None,
            top_p: None,
            top_k: None,
            num_ctx: None,
            repeat_penalty: None,
            stop: None,
        })
        .await
        .unwrap();
    let chunk = stream.next().await.unwrap().unwrap();
    assert_eq!(chunk.message.unwrap().thinking.as_deref(), Some("think"));
    assert!(stream.next().await.is_none());
}

/// A loopback server that echoes the request head back as the body, so a
/// test can assert on the headers the adapter actually sent. `serve_once`
/// discards the request, which is enough for status and body assertions
/// but not for "did it authenticate".
async fn serve_echoing_headers() -> (String, Arc<Mutex<Option<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let captured: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let sink = captured.clone();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = vec![0_u8; 8192];
        let read = socket.read(&mut buf).await.unwrap();
        let head = String::from_utf8_lossy(&buf[..read]).to_string();
        *sink.lock().await = Some(head);
        // Answer with a well-formed empty model list so list_models
        // succeeds and the test is asserting only on the headers.
        let body = r#"{"models":[]}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = socket.write_all(response.as_bytes()).await;
    });
    (format!("http://{}", address), captured)
}

#[tokio::test]
async fn ollama_sends_an_authorization_header_when_a_key_is_configured() {
    // OllamaProvider::new used to discard its api_key argument, so every
    // ollama.com request went out unauthenticated.
    let (url, captured) = serve_echoing_headers().await;
    let provider = OllamaProvider::new(url, Some("sk-test-key".to_string()));
    provider.list_models().await.unwrap();

    let head = captured
        .lock()
        .await
        .clone()
        .expect("no request was captured");
    assert!(
        head.contains("authorization: Bearer sk-test-key"),
        "expected a bearer header, got:\n{}",
        head
    );
}

#[tokio::test]
async fn ollama_sends_no_authorization_header_without_a_key() {
    // A local server must not be sent a header it does not expect.
    let (url, captured) = serve_echoing_headers().await;
    let provider = OllamaProvider::new(url, None);
    provider.list_models().await.unwrap();

    let head = captured
        .lock()
        .await
        .clone()
        .expect("no request was captured");
    assert!(
        !head.to_lowercase().contains("authorization"),
        "unexpected authorization header:\n{}",
        head
    );
}

#[tokio::test]
async fn ollama_cloud_without_a_key_reports_401_as_a_typed_api_error() {
    // Review Focus: the UI has to be able to say "check your Ollama cloud
    // key". An opaque transport failure gives it nothing to say.
    let url = serve_once(
        "401 Unauthorized",
        r#"{"error":"unauthorized"}"#,
        "application/json",
    )
    .await;
    let provider = OllamaProvider::new(url, None);
    match provider.list_models().await {
        Err(ProviderError::Api { status: 401, .. }) => {}
        other => panic!(
            "expected a typed 401 so the UI can name the cause, got {:?}",
            other
        ),
    }
}

#[tokio::test]
async fn probe_forwards_the_api_key_to_ollama() {
    // probe() is what the Settings screen calls when a user adds a cloud
    // provider. If it drops the key, every cloud connection test fails
    // while the stored key sits there looking correct.
    let (url, captured) = serve_echoing_headers().await;
    let _ = probe("ollama", &url, Some("sk-probe-key")).await;

    let head = captured
        .lock()
        .await
        .clone()
        .expect("probe sent no request");
    assert!(
        head.contains("authorization: Bearer sk-probe-key"),
        "probe dropped the api key, got:\n{}",
        head
    );
}
