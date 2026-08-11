# Convo Release Checklist

> Automated gates recorded locally on 2026-08-09. Manual and installed-artifact checks remain intentionally unchecked.

## Automated Gates

- [x] `npm ci`
- [x] `npm run check:version`
- [x] `npm run check:commands`
- [x] `npm run typecheck`
- [x] `npm run test:run` (252 tests)
- [x] `npm run build`
- [x] `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`
- [x] `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- [x] `cargo test --manifest-path src-tauri/Cargo.toml` (35 tests)
- [x] `npm run tauri build` (Debian + AppImage, with the pinned linuxdeploy path)

## Fresh Install

- [ ] Add and probe Ollama or OpenAI-compatible provider.
- [ ] Refresh/select a model and start a chat.
- [ ] Stream, stop, retry, navigate away, return, and restart the app.
- [ ] Test picker, drag/drop, paste, and image attachment delivery.
- [ ] Create, edit, toggle, delete, and extract Memory items.
- [ ] Open every sidebar route and every Settings tab.
- [ ] Create, edit, filter, and delete Notes and Tasks.
- [ ] Create/edit DB documents and open/save a disk document.
- [ ] Run Compare with partial failure and cancellation.
- [ ] Test DuckDuckGo, SearXNG, and Brave search configuration.

## Upgrade And Adverse Conditions

- [ ] Migrate a copied existing database and verify counts/history.
- [ ] Restore a backup into a disposable data directory.
- [ ] Test provider offline, wrong key, malformed stream, no GPU, and missing tools.
- [ ] Test read-only/disk-full behavior preserves drafts and reports errors.
- [ ] Test interrupted backup import rolls back safely.

## Package Smoke

- Artifacts generated: `src-tauri/target/release/bundle/deb/Convo_0.7.0_amd64.deb` and `src-tauri/target/release/bundle/appimage/Convo_0.7.0_amd64.AppImage`.
- [ ] Install the generated Debian/AppImage artifact without the dev server.
- [ ] Verify app name, icon, version, desktop entry, capabilities, and data path.
- [ ] Repeat the P0 checklist against the installed artifact.
