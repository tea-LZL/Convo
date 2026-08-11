# Known Limitations

- Provider reachability and model metadata depend on the configured server's API behavior.
- OpenAI-compatible vision/reasoning fields vary by provider; unsupported fields are ignored safely.
- Backup restore requires an application restart because the running SQLite connection is not hot-swapped.
- Full manual fresh-install, upgrade-install, adverse-condition, and packaged-artifact evidence must be recorded before an RC tag.
- Automated axe coverage currently covers the shared modal and responsive shell; route-by-route installed-app accessibility review remains manual.
- GitHub CI has not yet run against this worktree; local clean-install gates pass, but the workflow result still needs confirmation.
- `npm ci` currently reports 10 audit findings (8 moderate, 1 high, 1 critical).
