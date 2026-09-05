# Private history and planner phase

## Railway setup

The provided `Sherwin-Aniesh/SafeLink` dataset was checked and is public. Do not
use it for conversations. Do not change the existing ocean-data configuration.

1. Create a **separate private** Hugging Face dataset, for example
   `Sherwin-Aniesh/SafeLink-Chats`.
2. In Railway service Variables add:

   ```text
   HF_CHAT_DATASET_REPO=Sherwin-Aniesh/SafeLink-Chats
   HF_CHAT_TOKEN=<token with read/write access to that private dataset>
   ```

   You may omit `HF_CHAT_TOKEN` if the existing `HF_TOKEN` already has access.
   Never put a token in GitHub, frontend code, or a chat message.
3. Deploy this version using **one worker and one replica**. The archive is a
   small MVP object-store adapter, not a transactional multi-user database.
4. Open Ask SafeLink → History and opt in to private archive storage. Existing
   idle conversations are saved when you enable it; subsequent completed turns
   are saved automatically. A public repository is rejected before reading/writing.
5. Send a test message, wait for the reply/save to finish, restart the backend,
   then reopen History in the **same browser**. Check the conversation is present.
6. Delete the test conversation and verify it is absent after another restart.

## Privacy and durability

- Off by default for each browser. Messages and their source/step metadata are
  uploaded only after opting in. Messages can contain locations or other personal
  information. Dataset collaborators can read this data; no application-level
  encryption is implemented. Keep the dataset private permanently.
- The archive stores a hash of the browser identity in its file path, not the
  authentication cookie itself. Access is still tied to that cookie, which has a
  maximum one-year lifespan when enabled. Clearing it loses access. There is no
  account-based recovery, cross-device synchronization, or unlimited retention SLA.
- Archives survive app restarts but remain bounded to eight conversations with
  the latest 40 messages each and a 2 MB per-browser document limit. Model context
  remains limited to recent messages, independent of displayed history.
- Delete updates the current dataset file. Hugging Face repository history/cache
  can retain earlier versions; this is **not verified permanent erasure**. For
  deletion guarantees, use a purpose-built database with a reviewed retention policy.
- No archive upload or repository-visibility mutation is performed by setup code.
- Failed writes retain the local transcript and surface an unverified-save notice.
  Failed archive reads do not overwrite existing remote data. Restart durability
  is not guaranteed for failed or interrupted saves. Retry before closing the page.
- Turning off archive storage stops future saves; it does not erase old versions.
- Do not share this dataset with the ocean refresh/squash pipeline. The code also
  rejects a chat repository equal to `HF_DATASET_REPO`.

## Planner changes

- Up to four typed read-only tasks per plan, with optional dependency ordering.
- Unknown dependencies, duplicate IDs and cycles are rejected before execution.
- Failed or partial prerequisite checks skip downstream tasks.
- A 20-second overall deadline returns explicit timeout/partial results.
- Four process-wide specialist slots bound concurrent work, including timed-out
  requests still finishing in the background. Synchronous requests cannot be
  forcibly canceled; late results are discarded, not represented as successes.
- Child tasks count against the same 12-call per-reply budget as their parent.
- Dependencies only control order. Arguments requiring an earlier result still
  need a subsequent model tool call with verified returned coordinates.
- These are bounded function-based specialists, not the complete proposed
  multi-agent system. Official-warning, vessel-policy and navigation validation
  remain unimplemented; safety assessments stay UNKNOWN when required inputs lack.

## Tests

Run `python -m unittest discover -s backend/tests` in the project environment,
`pnpm install --frozen-lockfile`, and `pnpm run build`.
Archive unit/API tests mock the Hub: no real user conversation is uploaded.
They cover public-repository refusal, hashed identity, merging, opt-in, restart
recovery, browser isolation, deletion, and failed-sync reporting. Planner tests
cover concurrency, dependencies, validation, deadlines and tool-cost accounting.
