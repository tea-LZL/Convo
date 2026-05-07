use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

#[derive(Clone)]
pub struct ActiveStreams(pub Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>);

impl ActiveStreams {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(HashMap::new())))
    }
}
