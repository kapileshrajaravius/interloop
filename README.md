# Interloop

Interloop by LEAP C.O. helps high schoolers in grades 9–12 find internships, summer programs and volunteering, then plan their applications.

## How it's hosted

- **GitHub Pages:** every push to `main` runs `.github/workflows/deploy-pages.yml`, which publishes the `public/` folder.
- **Firebase Hosting (test copy):** `firebase deploy --only hosting` publishes the same `public/` folder to interloop-425da.web.app.
- **AI:** the AI buttons use Firebase AI Logic (Gemini) with App Check. The Gemini key stays in the Firebase project and is never in this repo. The Firebase config and reCAPTCHA site key in `public/index.html` are public by design.

## Updating the site

1. Replace `public/index.html` with the new version.
2. `git add -A && git commit -m "Update Interloop" && git push`
3. Check the **Actions** tab. When the run is green, the site is updated.
