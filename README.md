# Interloop

Interloop by LEAP C.O. helps high schoolers in grades 9–12 find internships, summer programs and volunteering, then plan their applications.

## How it's hosted

- **GitHub Pages:** `.github/workflows/deploy-pages.yml` publishes the `public/` folder on every push to `main` and every Monday.
- **Firebase Hosting (test copy):** `firebase deploy --only hosting` publishes the same `public/` folder to interloop-425da.web.app.
- **AI on the site:** Firebase AI Logic (Gemini) with App Check. No secret keys are in this repo; the Firebase config and reCAPTCHA site key in `public/index.html` are public by design.

## Live listings

`scripts/update-listings.mjs` runs before each deploy and writes `public/data/live-listings.json`, which is the page's only source of listings. There are no built-in listings; until the first run finishes the page shows "No listings right now".

| Source | What it adds | When | Secret(s) |
|---|---|---|---|
| USAJOBS API | Federal Pathways internships open to high schoolers | Every run | `USAJOBS_API_KEY`, `USAJOBS_EMAIL` |
| Adzuna API | Internships from job boards that mention high schoolers | Every run | `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` |
| AI web search (Gemini + Google Search) | Summer programs, internships and volunteering from official sites | Mondays and manual runs | `GEMINI_API_KEY` |
| Idealist API | Volunteering (planned, needs partner approval) | — | — |
| Points of Light Engage | Volunteering (planned, needs partner approval) | — | — |

Every AI find is checked against its official page (must load and mention high schoolers) before it's kept. Finds are saved in `data/found-listings.json`, re-checked weekly, and dropped when the deadline passes or the page disappears.

Add secrets under **Settings → Secrets and variables → Actions**. Without them the site still deploys.

To hide a listing for good, add its id or URL to `data/blocked.txt` and push.

## Updating the site

1. Replace `public/index.html` with the new version.
2. `git add -A && git commit -m "Update Interloop" && git push`
3. Check the **Actions** tab. When the run is green, the site is updated.
