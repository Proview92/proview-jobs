# Proview Jobs

Job management for Proview Tech. Managers create jobs and assign them to staff; staff see only their own jobs, tick off tasks and parts, and finish with notes and photos. A manager can also create a job by sending a WhatsApp message that starts with the word **Job**.

Set up the same way as the other Proview apps: a single-page app on GitHub Pages, with logins and data in Supabase.

- **App:** `index.html` (built from `src/` with `python3 build.py`)
- **Cloud:** `cloud.json` points the app at the `proview-jobs` Supabase project. See [SETUP.md](SETUP.md).
- **Database:** `supabase/schema.sql`
- **Function:** `supabase/functions/whatsapp-webhook` (WhatsApp messages and the app's Quick add)
- **Tests:** `tests/`

Pushing to `main` redeploys through GitHub Pages.

## Changing the app
Edit the pieces in `src/`, run `python3 build.py`, commit `index.html` with them.

## Tests
    node tests/parse.test.mjs      # how messages are read
    node tests/handler.test.mjs    # the webhook, with stand-in services
    python3 -m http.server 8765 &  # then:
    NODE_PATH=$(npm root -g) node tests/ui.test.cjs   # the screens, in a headless browser
