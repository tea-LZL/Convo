#[cfg(test)]
mod tests {
    use crate::providers::types::ChatResponseChunk;

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
}
