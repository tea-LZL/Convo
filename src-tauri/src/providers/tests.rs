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

/// Serve one canned HTTP response on an ephemeral loopback port, and return
/// the base URL to ask for it at. `Connection: close` and a `Content-Length`
/// so the client reads the body and finishes without the server having to
/// keep the connection alive.
///
/// `pub(crate)` so a test outside this module can serve a real response
/// instead of stubbing the transport. `memory::context_tests` uses it to
/// stand up a working embedding endpoint, because the send path's vector
/// route is only testable end to end against an actual provider — a stub
/// swapped in at the seam would test a second implementation of provider
/// resolution rather than this one, and two copies of a loopback server
/// drift.
pub(crate) async fn serve_once(status: &str, body: &str, content_type: &str) -> String {
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

/// A loopback server that reads the whole request — headers and the body
/// named by `Content-Length` — captures it, and answers with a canned body.
/// `serve_once` reads only the first packet, which is enough for a status
/// assertion but can lose a POST body written separately.
async fn serve_capturing_request(
    response_body: &'static str,
    content_type: &'static str,
) -> (String, Arc<Mutex<Option<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let captured: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let sink = captured.clone();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0_u8; 4096];
        loop {
            let read = match socket.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            buf.extend_from_slice(&chunk[..read]);
            if let Some(head_end) = find_subsequence(&buf, b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buf[..head_end]).to_lowercase();
                let content_length = head
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .and_then(|value| value.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if buf.len() >= head_end + 4 + content_length {
                    break;
                }
            }
        }
        *sink.lock().await = Some(String::from_utf8_lossy(&buf).to_string());
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            content_type,
            response_body.len(),
            response_body,
        );
        let _ = socket.write_all(response.as_bytes()).await;
    });
    (format!("http://{}", address), captured)
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// The system prompt and the sampling knobs must reach Ollama's
/// `/api/chat`. They used to be sent as top-level fields, which that
/// endpoint ignores: the persona and the whole `<memory-context>` block
/// never arrived, and every model answered from its weights alone while the
/// recall log recorded a successful injection.
#[tokio::test]
async fn ollama_carries_the_system_prompt_as_a_message_and_options() {
    let (url, captured) = serve_capturing_request(
        "{\"message\":{\"role\":\"assistant\",\"content\":\"hi\"},\"done\":true}\n",
        "application/x-ndjson",
    )
    .await;
    let provider = OllamaProvider::new(url, None);
    let mut stream = provider
        .chat_stream(ChatRequest {
            model: "model".into(),
            messages: vec![MessageContent {
                role: "user".into(),
                content: "what is my name".into(),
                thinking: None,
                images: vec![],
            }],
            stream: true,
            system: Some("You MUST use these relevant facts: Kevin".into()),
            temperature: Some(0.7),
            top_p: Some(0.9),
            top_k: Some(40),
            num_ctx: Some(8192),
            repeat_penalty: Some(1.1),
            stop: Some(vec!["</s>".into()]),
        })
        .await
        .unwrap();
    while stream.next().await.is_some() {}

    let request = captured.lock().await.clone().expect("no request captured");
    let body = request.split("\r\n\r\n").nth(1).unwrap_or("");
    let parsed: serde_json::Value = serde_json::from_str(body)
        .unwrap_or_else(|e| panic!("request body is not JSON: {e}\n{body}"));

    assert!(
        parsed.get("system").is_none(),
        "system must not be a top-level field; /api/chat ignores it:\n{body}"
    );
    let messages = parsed["messages"].as_array().expect("messages array");
    assert_eq!(messages[0]["role"], "system");
    assert!(
        messages[0]["content"].as_str().unwrap().contains("Kevin"),
        "the memory block did not survive the request build:\n{body}"
    );
    assert_eq!(messages[1]["role"], "user");
    assert!(
        parsed.get("temperature").is_none(),
        "temperature must live under options, not at the top level:\n{body}"
    );
    assert_eq!(parsed["options"]["num_ctx"], 8192);
    assert_eq!(parsed["options"]["temperature"], 0.7);
    assert_eq!(parsed["options"]["top_k"], 40);
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

#[tokio::test]
async fn ollama_embed_parses_the_embeddings_array() {
    let url = serve_once(
        "200 OK",
        r#"{"embeddings":[[1.0,2.0],[3.0,4.0]]}"#,
        "application/json",
    )
    .await;
    let provider = OllamaProvider::new(url, None);
    let out = provider
        .embed("nomic-embed-text", &["a".to_string(), "b".to_string()])
        .await
        .unwrap();
    assert_eq!(out, vec![vec![1.0, 2.0], vec![3.0, 4.0]]);
}

#[tokio::test]
async fn ollama_embed_sends_the_key_to_a_cloud_endpoint() {
    let (url, captured) = serve_echoing_headers().await;
    let provider = OllamaProvider::new(url, Some("sk-embed".to_string()));
    // A malformed body is fine; the assertion is on the request head.
    let _ = provider.embed("gpt-oss:120b", &["hello".to_string()]).await;
    let head = captured.lock().await.clone().expect("no request captured");
    assert!(
        head.contains("authorization: Bearer sk-embed"),
        "got:\n{}",
        head
    );
    assert!(head.contains("POST /api/embed"), "got:\n{}", head);
}

#[tokio::test]
async fn openai_compat_embed_parses_the_data_array() {
    let url = serve_once(
        "200 OK",
        r#"{"data":[{"embedding":[1.0,2.0]}]}"#,
        "application/json",
    )
    .await;
    let provider = OpenAiCompatProvider::new(url, None);
    let out = provider.embed("m", &["a".to_string()]).await.unwrap();
    assert_eq!(out, vec![vec![1.0, 2.0]]);
}

#[tokio::test]
async fn openai_compat_embed_sorts_by_the_response_index() {
    // Ollama's OpenAI-compatible endpoint does not guarantee the response
    // order matches the request order. RRF fuses by rank, so an
    // out-of-order response silently pairs a query with the wrong
    // document rather than erroring.
    let url = serve_once(
        "200 OK",
        r#"{"data":[{"index":1,"embedding":[3.0,4.0]},{"index":0,"embedding":[1.0,2.0]}]}"#,
        "application/json",
    )
    .await;
    let provider = OpenAiCompatProvider::new(url, None);
    let out = provider
        .embed("m", &["first".to_string(), "second".to_string()])
        .await
        .unwrap();
    assert_eq!(out, vec![vec![1.0, 2.0], vec![3.0, 4.0]]);
}

#[tokio::test]
async fn embed_reports_a_missing_endpoint_rather_than_failing_opaquely() {
    let url = serve_once(
        "404 Not Found",
        r#"{"error":"not found"}"#,
        "application/json",
    )
    .await;
    let provider = OllamaProvider::new(url, None);
    match provider.embed("m", &["a".to_string()]).await {
        Err(ProviderError::Api { status: 404, .. }) => {}
        other => panic!("expected a typed 404, got {:?}", other),
    }
}

#[tokio::test]
async fn embed_rejects_a_response_whose_vector_count_does_not_match_its_inputs() {
    // One vector for two inputs is worse than an error: the caller would
    // pair inputs with the wrong vectors.
    let url = serve_once(
        "200 OK",
        r#"{"embeddings":[[1.0,2.0]]}"#,
        "application/json",
    )
    .await;
    let provider = OllamaProvider::new(url, None);
    match provider
        .embed("m", &["a".to_string(), "b".to_string()])
        .await
    {
        Err(ProviderError::Parse(_)) => {}
        other => panic!(
            "expected a Parse error for a count mismatch, got {:?}",
            other
        ),
    }
}

#[tokio::test]
async fn openai_compat_embed_rejects_a_count_mismatch_too() {
    let url = serve_once(
        "200 OK",
        r#"{"data":[{"index":0,"embedding":[1.0]}]}"#,
        "application/json",
    )
    .await;
    let provider = OpenAiCompatProvider::new(url, None);
    assert!(matches!(
        provider
            .embed("m", &["a".to_string(), "b".to_string()])
            .await,
        Err(ProviderError::Parse(_))
    ));
}

#[tokio::test]
async fn embed_of_an_empty_input_list_needs_no_request() {
    // A provider with nothing to embed must not spend a round trip. The
    // loopback server would answer nothing and the test would hang.
    let provider = OllamaProvider::new("http://127.0.0.1:1".to_string(), None);
    let out = provider.embed("m", &[]).await.unwrap();
    assert!(out.is_empty());
}

#[tokio::test]
async fn embed_rejects_vectors_of_inconsistent_dimension() {
    // A corpus where one vector is 768-dim and another is 1024-dim cannot
    // be compared. Catching it here beats a NaN cosine downstream.
    let url = serve_once(
        "200 OK",
        r#"{"embeddings":[[1.0,2.0],[3.0,4.0,5.0]]}"#,
        "application/json",
    )
    .await;
    let provider = OllamaProvider::new(url, None);
    assert!(matches!(
        provider
            .embed("m", &["a".to_string(), "b".to_string()])
            .await,
        Err(ProviderError::Parse(_))
    ));
}
