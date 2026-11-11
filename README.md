# Avito Academy 2.0

Telegram Mini App with a private API and administrator workspace. The app and API are served from one HTTPS origin. Content, learner progress and uploaded media are stored on the server; uploads are kept outside the public website directory.

## Run the server

Requirements: Node.js 20 or newer, a persistent writable disk, and an HTTPS address for Telegram.

```sh
npm install
cp .env.example .env
```

Set these values in `.env` (or the hosting provider's environment settings):

- `BOT_TOKEN`: token from BotFather for `@avito_abk_bot`.
- `ADMIN_TELEGRAM_IDS`: comma-separated Telegram numeric user IDs allowed into the admin panel.
- `PORT`: the port supplied by the host, if required.

Then run `npm start`. Open the deployed HTTPS address in BotFather's Mini App settings or the bot's Web App button. The app uses its own origin for `/api`; there is no placeholder API URL to replace. To use a separate API host, set `window.ACADEMY_API_URL` before `config.js` loads and configure that host to accept requests from the app origin.

Use a host that preserves `data/` and `private_uploads/` across restarts. The GitHub Pages static host cannot run this API or persist SQLite/uploads by itself; deploy the Node server on a VPS or Node application host. Never commit `.env`, the SQLite database, or uploaded files.

## Admin panel

Open the Mini App from the Telegram bot using an account ID listed in `ADMIN_TELEGRAM_IDS`. In the app, open **Кабинет → Управление академией**. Add and edit modules, lessons, test questions, and materials there. Save a lesson or material before uploading its file; supported uploads are MP4/WebM for lessons and PDF/TXT/ZIP/PNG/JPG for materials, up to 250 MB.

Mark a module, lesson, or library item as paid in its editor. Paid items are returned only to administrators; student content, quiz, progress, and file-download endpoints do not expose them. There is no payment or purchase entitlement flow yet, so paid materials stay unavailable to learners until that server-side flow is implemented.

## Available now and server dependencies

- Works when deployed with this server: Telegram identity validation, admin access by ID, CRUD for modules/lessons/questions/materials, private file upload and delivery, learner progress, favorites, quiz scoring, and student list.
- Requires the deployment environment: bot token, administrator IDs, HTTPS, Node.js hosting, persistent storage, and the Mini App URL configured in Telegram.
- Not implemented: payments/purchase checks, automatic lesson unlock rules, cloud object storage/CDN, and administration from an ordinary web browser outside Telegram.
