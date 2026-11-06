# Tandra Asset Hub — tandrahub.com

Client website and staff portal for Tandra Asset Hub Ltd.

- **Client site:** `https://tandrahub.com` — estates, application form with uploads and signatures, offer letters, payments by bank transfer with evidence, allocation letters with QR verification, terms PDF.
- **Staff portal:** `https://tandrahub.com/#staff` — sign in with `STAFF_EMAIL` / `STAFF_PASSWORD` from Render.

## How it runs
| Part | Where |
|---|---|
| Website + API (`server/server.js`) | Render, free web service |
| Data and uploaded files | Neon Postgres (free), via `DATABASE_URL` |
| Domain | Spaceship DNS → Render |

Without `DATABASE_URL` the server keeps data in `./data` — fine for testing on your own computer, but Render's free plan wipes that folder on every restart.

## Updating the site
The page is built from the app source:
```
python3 build/build.py path/to/tandra.html   # writes public/index.html
git commit -am "Update site" && git push       # Render redeploys automatically
```

## Security notes
- Client passwords are hashed (scrypt); sessions last 60 days.
- Clients can only see and change their own records. Payment and fee confirmations, offers, allocations, prices and unit counts can only be changed by staff.
- Uploaded files are served from unguessable links (`/f/...`).
- Payments are by bank transfer only, with evidence of payment that staff confirm.
- Email and SMS are not connected yet (Resend and an SMS provider are the next steps).

## Keeping storage free
Neon's free plan gives 1 GB. To stay inside it:
- Passport photos are shrunk in the browser to about 10–25 KB; payment evidence to about 60–150 KB; estate photos to about 120–300 KB. PDFs are limited to 2 MB.
- Only the ID number is collected — no ID copies are stored.
- Uploads nothing points to (abandoned forms, replaced photos) are deleted automatically after 7 days.
- Staff can see usage and remove unused uploads in **Settings → Storage**.
