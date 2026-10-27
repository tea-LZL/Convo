# Convo Release Checklist

> Automated gates recorded locally on 2026-08-09, re-run on 2026-10-28. Manual and installed-artifact checks remain intentionally unchecked.
>
> **Partly stale.** The gates were first recorded for the v0.7 workspace-shaped app. The product has since been realigned — see `docs/GOALS.md`, which is canonical. The 2026-10-28 re-run (869 frontend tests, 312 Rust tests, 1 ignored release-only latency gate) is current; the 252-test figure belongs to 2026-08-09 and is kept as point-in-time evidence. The manual sections below are the remaining release work.

## Automated Gates

- [x] `npm ci`
- [x] `npm run check:version`
- [x] `npm run check:commands`
- [x] `npm run typecheck`
- [x] `npm run test:run` (252 tests on 2026-08-09; 869 on 2026-10-28)
- [x] `npm run build`
- [x] `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`
- [x] `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- [x] `cargo test --manifest-path src-tauri/Cargo.toml` (35 tests on 2026-08-09; 105 on 2026-09-27; 312 on 2026-10-28, plus the ignored release-mode recall latency gate)
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
