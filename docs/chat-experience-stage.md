# SafeLink chat experience stage

This stage adds a permission-based startup location chooser, Markdown answers,
provider references from successful tools, and a working conversation list.
It does not change the ocean renderer or introduce a new forecast model.

## Verify locally

1. Run `pnpm install --frozen-lockfile` and `pnpm run build`.
2. Run `.venv\Scripts\python.exe -m unittest discover -s backend/tests` on Windows.
3. For offline browser checks, set `AI_PROVIDER=openai` in the test shell and run
   `.venv\Scripts\python.exe -m scripts.mock_chat_server` on port 8014.
   This fixture substitutes an AI client and must never be deployed as the app.
4. With Playwright and its Chromium browser installed, run
   `node scripts/chat_ui_smoke.cjs`. If using an external Playwright installation,
   set `PLAYWRIGHT_MODULE` to its module directory. No paid AI call is made.

The browser check covers startup skip, formatted answers, creating a new chat,
reopening a conversation, recovery after reload, and deletion.

## Verify after deployment

- On first page load, choose device location, choose a map point, or skip.
  Browser geolocation is requested only after pressing the device-location button.
  Confirm the position before using it; startup confirmation does not run a PFZ search.
- Open Ask SafeLink. Ask for conditions at a selected point or a weather forecast
  with explicit dates. Source links appear for successful supported tools.
- Use New conversation, then History to reopen the old one. Reload and repeat.
- Delete a history entry and confirm it disappears.

## Limits

- History is private to the browser cookie, in one server process, and bounded to
  20 message pairs per conversation. It expires after two hours of inactivity and
  is lost on server restart. Multiple server workers/replicas need a shared store.
- New conversation preserves the old one; Delete permanently removes it from this
  process. No account synchronization or durable database is introduced.
- The assistant's model context is separate from displayed history and remains
  bounded. Reopening history never replays map actions.
- Source cards link to providers; they are not per-measurement verification.
  Open-Meteo weather forecasts remain available alongside Copernicus and INCOIS.
  No new official-warning feed or unrestricted web access is added in this stage.
- Markdown does not execute raw HTML, load images, or allow non-HTTP(S) links.
- Full Docker/Railway image testing still requires Docker or a Railway build.
  A successful local frontend build is not proof of a successful cloud deployment.
