# dsh-remote-control

Secure remote control for the DeepSeek Harness running on this computer.
It ships as a Desktop-bundled Cordis bundle with a Host service, desktop
control panel, and standalone mobile page.

## Capabilities

- Remote control is **off after every backend launch** and must be started
  from the authenticated desktop panel.
- One-time, five-minute QR pairing tokens are held only in memory as hashes.
- Temporary device credentials expire after 8 hours.
- Trusted devices require explicit desktop confirmation and expire after 90
  idle days. Each device can be revoked independently.
- Device credentials are HMAC-signed and checked against the persistent
  registry on every call; the mobile API uses Bearer auth rather than the
  desktop cookie.
- `/remote` provides a phone-first UI for existing workspace/session groups,
  history polling, queued prompts, cancellation, running state, tool events,
  and read-only approval notices.
- Prompt request IDs include the source device plus a client nonce, with a
  replay cache so reconnect retries do not submit twice.
- The restricted API exposes session list/history/prompt/cancel only. It does
  not expose raw terminals, arbitrary filesystem access, plugin/settings
  management, or arbitrary workspace creation.
- Device and lifecycle events are written to a content-free JSONL audit log.
- A dedicated HTTP server binds one physical RFC1918 adapter address and fixed
  port. It exposes only the five mobile/device routes; DSH itself remains
  loopback-only. This transport is unencrypted and is for trusted LANs only.

The registry lives at `$DSH_HOME/remote-control/devices.json`; audit records
live beside it in `audit.jsonl`.

## Routes

### Desktop operator routes

These are registered through `connection.fetch`, so the existing Host,
Origin, launch-token/cookie, and CSRF protections apply:

- `POST /api/remote-control/status`
- `POST /api/remote-control/start`
- `POST /api/remote-control/stop`
- `POST /api/remote-control/pair`
- `POST /api/remote-control/qr`
- `POST /api/remote-control/devices`
- `POST /api/remote-control/confirm`
- `POST /api/remote-control/revoke`

### Device routes

- `GET /remote`, `/remote/app.js`, `/remote/app.css`
- `POST /remote-control/exchange` — one-time pairing token
- `POST /remote-control/device-api` — per-device Bearer credential

## Layout

| File | Role |
|---|---|
| `index.js` | Stable bundle entry |
| `service.js` | Host lifecycle, routes, pairing, restricted session facade |
| `auth.js` | Pair-token hashing and HMAC device credentials |
| `store.js` | Atomic device registry and content-free audit log |
| `lan.js` | Private-adapter discovery, fixed-port listener, path allowlist |
| `reducer.js` | Session-event to mobile-message reduction |
| `client.js` | Desktop launcher, QR pairing, device management |
| `page/*` | Standalone mobile UI |
| `cordis.patch.yml` | Bundle patch row |

## Network boundary

The DSH backend remains loopback-only. When the desktop operator starts remote
control, the plugin selects a physical RFC1918 address (or validates the
configured `lanHost`) and listens on `lanPort` (default `57890`) only on that
address. The separate server has an exact path allowlist for `/remote` assets
and `/remote-control` device endpoints; `/`, `/api`, settings, and every other
path return 404. Stop/shutdown closes the listener.

The QR code uses `http://<private-ip>:57890/remote`. HTTP does not protect
history, prompts, or credentials from other devices on the same network. Use
this mode only on a trusted WPA2/WPA3 home or office LAN, never public Wi-Fi.
