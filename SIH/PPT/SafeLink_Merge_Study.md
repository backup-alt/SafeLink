# SafeLink Merge Study — Yday Repo (17d8b42) vs Your HAZZARD Feature
### Date: 2026-09-11 | Base: 7c8d978 (PR #10) | Remote HEAD: 17d8b42 | Local: 7c8d978 + HAZZARD

---

## 1. What exists where

| Location | Commit | Files | Status |
|----------|--------|-------|--------|
| **Base (both sides)** | `7c8d978` | All core SafeLink (catalog, PFZ, vessels, nautical, chat) | Common ancestor |
| **Yday Remote** `origin/main` | `17d8b42` (3 commits ahead) | + Emergency GET HELP + Safety Check mods | Already on GitHub, you are 3 behind |
| **Your Local** | `7c8d978` + working dir | + HAZZARD (alerts, guardrail) | 4 modified + 6 new untracked |

---

## 2. Yday team changes (must keep — DO NOT overwrite)

**10 files, 590 insertions, 60 deletions — from 7c8d978 to 17d8b42:**

| File | Change | Purpose |
|------|--------|---------|
| `.gitignore` | +3 | Ignore new HF cache? |
| `backend/hf_emergency.py` | **NEW 134 lines** | HF store for emergency requests |
| `backend/app.py` | **+38 lines at :1150** | `POST /api/emergency/help` + EMERGENCY_TYPES |
| `src/EmergencyHelpModal.tsx` | **NEW 187 lines** | Form to send help (fire/medical/engine...) |
| `src/App.tsx` | +13 lines | `import EmergencyHelpModal`, `showEmergencyModal`, `safetyCheckStarted`, moves `SafetyIndicator` into topbar with start/reset |
| `src/SafetyIndicator.tsx` | rewritten 87 lines | Safety check UI changed (was point+times, now needs `started/onStart/onReset`) |
| `src/VesselDetails.tsx` | +8 lines | `onGetHelp` prop → opens emergency modal |
| `src/api.ts` | +16 lines | `sendEmergencyHelp()` client |
| `src/styles.css` | +134 lines | Emergency modal + safety indicator styles |
| `src/types.ts` | +30 lines | `EmergencyRequest` types |

**Key: team touched `backend/app.py` at BOTTOM (:1150) and `src/App.tsx` at TOP (:11) + middle (:239) — different lines than your hazard.**

---

## 3. Your HAZZARD feature (must keep — DO NOT delete)

**4 modified + 6 new, 59 + untracked:**

| File | Change | Purpose | Overlap? |
|------|--------|---------|----------|
| `backend/ai/tools.py` | +7 lines (`get_guardrail_status` tool) | Chat "Is it safe?" | **NO — team never touched** |
| `backend/app.py` | **+3 lines at :246** | `from .alerts.routes import alerts_router` + `include_router` | **YES — same file, different line** (team at :1150, you at :246) |
| `src/App.tsx` | +16 lines (Guardrail imports + guardrailPoint + popupPoint) + fix `locationStep: 'choose'→null` | Guardrail banner + popup | **YES — same file, different lines** (team adds Emergency, you add Guardrail) |
| `src/OceanMap.tsx` | +35 lines (guard layers useEffect) | Red flashing zones | **NO — team never touched** |
| `backend/alerts/*` | **NEW 3 files** | geofence_service + weather_service + routes | **NO — brand new dir** |
| `public/geofences/*` | **NEW 1 file** | india_eez.geojson | **NO** |
| `src/utils/geofence.ts` | **NEW 1 file** | client geo helpers | **NO** |
| `src/components/GuardrailBanner.tsx` | **NEW** | Siren + banner | **NO** |
| `src/components/GuardrailPopup.tsx` | **NEW** | Toast popup | **NO** |
| `src/components/AlertOverlay.tsx` | **NEW** | (legacy, not mounted — OceanMap handles layers) | **NO** |
| `SIH/PPT/*` | **NEW** | Your presentation docs | **NO** |

**Result: Only 2 overlapping files, and they edit DIFFERENT lines → merge is safe, no overwrite.**

---

## 4. Proof: No overwrite

```
backend/app.py:
  Team: adds at line 1150 (END of file) — emergency endpoint
  You:  adds at line 246  (MIDDLE)      — alerts router
  → Both can coexist. Final file will have BOTH blocks.

src/App.tsx:
  Team: adds at line 11 (import EmergencyHelpModal) + 239 (showEmergencyModal + safetyCheckStarted) + 852 (move SafetyIndicator)
  You:  adds at line 14 (import GuardrailBanner/Popup) + 224 (fix locationStep) + 797 (guardrailPoint + popupPoint)
  → Different line numbers, no conflict except if git rebase overlaps import block — trivial to keep both.
```

**All other hazard files are NEW (untracked) — `git pull` will NEVER delete them.** `git status --short` shows them as `??` — they stay on disk through `git stash`/`pull`/`pop`.

---

## 5. How to pull yday repo WITHOUT touching hazard (study steps)

```bash
cd /Users/jbaraniganesh/Documents/SIH_2026/Safe_Link

# Check state before
git fetch origin
git log --oneline origin/main -3   # should show 17d8b42, 371cd5b, 75cfebe
git status --short                  # your 4 M + 6 ?? hazard files visible

# Stash ONLY tracked hazard edits (keeps untracked hazard files on disk)
git stash push -m "hazard before pull"

# Pull yday updates (gets Emergency + Safety Check)
git pull --rebase origin main
# Expected: Fast-forward or rebase applies team commits cleanly
# New files appear: backend/hf_emergency.py, src/EmergencyHelpModal.tsx

# Restore hazard on top
git stash pop
# If conflict in backend/app.py or src/App.tsx:
#   1. Open file, keep BOTH additions (team at bottom, yours at middle)
#   2. git add backend/app.py src/App.tsx
#   3. git stash drop  (if needed)

# Verify merged state
git status --short
ls backend/alerts/ backend/hf_emergency.py public/geofences/ src/EmergencyHelpModal.tsx src/components/Guardrail*
# All should exist together

# Run with merged code
./.venv/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000 --reload  # Terminal 1
pnpm install && pnpm dev                                                              # Terminal 2
# Test both: guardrail `curl /api/alerts/guardrail?lat=8.9&lng=79.0` AND emergency `POST /api/emergency/help`
```

---

## 6. How to push AFTER merge (so GitHub has both)

```bash
git add backend/alerts/ public/geofences/ src/utils/geofence.ts src/components/GuardrailBanner.tsx src/components/GuardrailPopup.tsx src/components/AlertOverlay.tsx
git add backend/ai/tools.py backend/app.py src/App.tsx src/OceanMap.tsx
# Note: team files (hf_emergency, EmergencyHelpModal...) are ALREADY committed in origin/main — don't re-add unless you changed them
git commit -m "feat: guardrail alerts - geofence + weather interrupt + chl<48h + waves + ships (SIH26176 #4)"
git push origin main
```

---

## 7. Checklist — yday repo is fully preserved

- [ ] `backend/hf_emergency.py` exists after pull
- [ ] `src/EmergencyHelpModal.tsx` exists after pull
- [ ] `src/SafetyIndicator.tsx` is team version (87 lines rewritten)
- [ ] `backend/app.py` has BOTH `alerts_router` (246) AND `emergency_help` (1150)
- [ ] `src/App.tsx` has BOTH `EmergencyHelpModal` + `GuardrailBanner/Popup`
- [ ] `backend/alerts/*` still on disk (never deleted)
- [ ] `pnpm build` passes (2090 modules)
- [ ] Both endpoints respond: `/api/alerts/guardrail` and `/api/emergency/help`

**If all checked, yday SafeLink is intact and hazard is layered on top — zero overwrite.**
