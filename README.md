# Scalable Realtime Chat

A minimum direct-message application using AWS Cognito for identity and local PostgreSQL as the development replacement for Amazon RDS.

## Run locally

1. Copy `.env.example` to `.env`, then fill in the Cognito user-pool values. The project’s existing `.env` can be retained if it already contains them.
2. Start Docker Desktop.
3. Run `docker compose up --build`.
4. Open `http://localhost:5173` and create/confirm an account through Cognito. Sign in with a second confirmed account in another browser session to test a direct conversation.

The server runs migrations automatically on startup. PostgreSQL data is retained in the `postgres_data` Docker volume. Use `docker compose down -v` only when you intentionally want to erase local chat data.

## Architecture

- Cognito remains the authentication provider. The browser sends an ID token and the API validates its signature, audience, issuer, expiration, and token use.
- The first authenticated request or socket connection syncs a local `users` profile. The directory therefore includes users after their first sign-in.
- Local PostgreSQL represents RDS. The backend is organized by `users`, `conversations`, and `messages` features, with shared database, authentication, and Socket.IO infrastructure under `server/src/core`.
- Messages are persisted through the REST API and emitted to authenticated Socket.IO rooms for exactly the sender and recipient. One reusable direct conversation exists for each pair of users.

## API

All endpoints require `Authorization: Bearer <Cognito ID token>`.

- `GET /api/users` — synced users other than the caller.
- `POST /api/conversations/direct` — opens a direct conversation with `{ "recipientUserId": "..." }`.
- `GET /api/conversations/:conversationId/messages` — latest 50 messages, with an optional `cursor` query parameter.
- `POST /api/conversations/:conversationId/messages` — persists `{ "body": "..." }` and emits `message:created`.
