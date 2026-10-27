# Known Limitations

## Memory core

- Without a configured embedding model, embeddings for the corpus, or a vector whose dimension matches the stored one, recall silently degrades to keyword-only. The sidebar status card and the Memory index banner carry that state; the chat prompt does not announce it.
- The review inbox lists pending and failed extraction rounds with the candidate facts; it does not yet render the proposed diff or the revision verdict side by side.
- Recall latency is measured by an ignored release-mode test (`recall_latency_p95_over_five_thousand_items`): p95 at 5,000 items is 27.1ms for the both-routes arm, 16.2ms vector-only, 9.5ms keyword-only, against a 50ms budget. It is a `--ignored` test because an unoptimised build's timings say nothing; it is not part of the default suite.

## Accessibility

- Automated axe coverage runs over the shared modal, the route shell, the responsive shell, and every sidebar route's rendered surface (`src/routes/__tests__/routeSmoke.test.tsx`). Installed-app review with a real screen reader remains manual.

## Platform and release

- Provider reachability and model metadata depend on the configured server's API behavior.
- OpenAI-compatible vision/reasoning fields vary by provider; unsupported fields are ignored safely.
- Backup restore requires an application restart because the running SQLite connection is not hot-swapped.
- Full manual fresh-install, upgrade-install, adverse-condition, and packaged-artifact evidence must be recorded before an RC tag.
- GitHub CI has not yet run against this worktree; local clean-install gates pass, but the workflow result still needs confirmation.
- `npm ci` currently reports 10 audit findings (8 moderate, 1 high, 1 critical).
