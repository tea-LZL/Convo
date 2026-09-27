# Convo Release Checklist

> Automated gates recorded locally on 2026-08-09. Manual and installed-artifact checks remain intentionally unchecked.
>
> **Stale.** These gates were recorded for the v0.7 workspace-shaped app. The product has since been realigned — see `docs/GOALS.md`, which is canonical. The test count below was 252 on 2026-08-09 and 263 on 2026-09-27; the recorded results below are point-in-time evidence for that date, not a current gate. Phase 9 of the realignment re-runs all of them.

## Automated Gates

- [x] `npm ci`
- [x] `npm run check:version`
- [x] `npm run check:commands`
- [x] `npm run typecheck`
- [x] `npm run test:run` (252 tests on 2026-08-09)
- [x] `npm run build`
- [x] `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`
- [x] `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- [x] `cargo test --manifest-path src-tauri/Cargo.toml` (35 tests on 2026-08-09; 105 on 2026-09-27)
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
