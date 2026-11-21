# Proview Jobs: how the cloud side is set up

## What runs where
| Part | Where |
|---|---|
| The app | GitHub Pages, from this repository (`index.html`) |
| Logins | Supabase Auth (email and password) in the `proview-jobs` project |
| People and roles | `pj_people` (manager or staff, with a WhatsApp number for managers) |
| Jobs, tasks, parts | `pj_jobs`, `pj_job_tasks`, `pj_job_parts` |
| Photos | Private storage bucket `job-photos`, listed in `pj_job_photos` |
| WhatsApp to job, and job notices | `whatsapp-webhook` function, logged in `pj_wa_log`; allowed numbers in `pj_wa_numbers` |

## Who sees what
The database enforces this, not just the screen.
- **Managers** see and change everything.
- **Staff** see only jobs assigned to them. On those they can start, finish or reopen the job, tick tasks and parts, write completion notes and add photos. They cannot edit the job, reassign it or see the team list.

## How people sign in
1. **First manager:** the first person to create an account becomes the manager.
2. **Everyone else:** a manager adds them under Team with their email. They open the app, choose "First time? Create your account" and use that same email.

## WhatsApp
With **Every message is a job** switched on (the default, on the app's WhatsApp page), any text typed or forwarded to the jobs line from an approved number creates a job; short replies such as "ok" or "thanks" are ignored. A phone's own auto-reply is ignored too: any message containing "(automated message)", "(automated response)" or "(auto-reply)". Switched off, a message must start with `Job`, `#job` or `New job`. Approved numbers are those on the Numbers list plus the WhatsApp number of each active manager. Messages from any other number are ignored and never stored. A photo sent or forwarded to the jobs line is saved on the job: with a caption it starts a new job, without one it joins the job that number sent in the last 10 minutes (or the one it is adding details to). Videos and documents create a job from their caption, but those files are not saved.

**Forwarded messages and photos become one job.** Everything a number forwards to the jobs line within 30 seconds of the last item goes onto the same job: forwarded text is added to the details, photos are attached. About 7 seconds after the last item arrives, one reply goes out with a **Choose staff** list and a request for the title; the next message that number types (within 15 minutes) becomes the job's title. Photos sent with nothing typed under them join the same job. A forwarded item sent while adding details to a job is still treated as those details.

    Job: Install 4 cameras at Al Noor Cafe
    Customer: Ahmed 050 123 4567
    Address: Shop 3, Al Wasl Road
    Due: tomorrow
    Priority: urgent
    Assign: Ravi
    Tasks: mount cameras, run cable, set up recorder
    Parts: 4x dome camera, 1 recorder

Only the first line is needed. `Due` understands today, tomorrow, weekday names, `25/11`, `25 Nov` and `2026-11-25`. `Assign` matches a team member's name.

### Which numbers can create jobs, and who is sent them
The app's WhatsApp page has a Numbers list (`pj_wa_numbers`). Each number can be allowed to **create** jobs, be **sent every new job**, or both, whether or not it belongs to someone with a login. Managers can also create from the number on their own profile, and whoever a job is assigned to is sent it on the number on theirs.

Job notices go out when a job arrives by WhatsApp, and when a manager creates or reassigns one in the app. WhatsApp only delivers free-text messages to someone who has written to the business number in the last 24 hours. To reach people outside that window, get a template approved in WhatsApp Manager with the body `New job {{1}}: {{2}}. {{3}}` and store its name as the secret `WA_TEMPLATE` (and `WA_TEMPLATE_LANG` if it is not `en`).

### Buttons under the reply
The "Job J-0012 created" reply carries three buttons: **Assign staff** (a pick-list of the team), **Set priority** (a pick-list) and **Add details**. After Add details, the next ordinary message from that number within 30 minutes is added to the job, using the same lines (Customer, Address, Due, Tasks, Parts) or plain notes. Only numbers allowed to create jobs can use them. WhatsApp shows at most 10 rows in a list, so the first 9 team members by name are offered.

### Connecting a number (Meta WhatsApp Cloud API)
The normal WhatsApp Business app cannot hand messages to other software by itself. The number that receives job messages has to be on Meta's Cloud API.

1. At developers.facebook.com create an app (type Business) and add the WhatsApp product.
2. Under WhatsApp > API Setup, add the phone number that will receive job messages, or use Meta's free test number to try it.
3. Under WhatsApp > Configuration, set the Callback URL to
   `https://<project>.supabase.co/functions/v1/whatsapp-webhook`, enter your verify phrase, and subscribe to **messages**.
4. Store three secrets for the function (Supabase > Edge Functions > Secrets):
   - `WA_VERIFY_TOKEN`: the verify phrase you typed in step 3 (any phrase you choose)
   - `WA_APP_SECRET`: Meta app > App settings > Basic > App secret
   - `WA_ACCESS_TOKEN`: a permanent system-user token with `whatsapp_business_messaging`. Needed for replies and job notices.
   - `WA_PHONE_NUMBER_ID`: the Phone number ID shown under WhatsApp > API Setup. Needed for job notices sent from the app.

**Keeping your existing WhatsApp Business app number:** Meta allows one number on both the app and the API ("coexistence"), but only through a Meta partner's sign-up flow, not directly. If you go that way the function also understands messages you type yourself in the Business app (`smb_message_echoes`), provided the partner passes Meta's webhooks through with Meta's signature.

## Still to do by hand
1. **Site URL:** Supabase > Authentication > URL Configuration: set the Site URL to the app's address so email links come back to the app.
2. **Email sending:** Supabase's built-in email is limited to a few messages an hour. Connect your own SMTP (for example Resend) before adding many staff.

## Rebuilding from scratch
Run `supabase/schema.sql`, then `supabase/schema-2-wa-actions.sql`, then `supabase/schema-3-wa-bundles.sql`, in the SQL editor, then:

    supabase functions deploy whatsapp-webhook --no-verify-jwt
