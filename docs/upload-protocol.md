# Podium upload protocol (version 1)

Podium can upload clips to any server that speaks this protocol. Such a server is called
**Podium-compatible**. The protocol is plain HTTPS and JSON. Video bytes go up in resumable chunks, so a
600 MB bookmark survives a dropped Wi-Fi connection. A server can also take the whole file in one request
by asking for one big chunk.

This document is the whole contract. If you implement what it describes, Podium (and any other client
that follows it) can upload to your server. [`upload-reference-server.ts`](upload-reference-server.ts) is
a complete server in about 350 lines with no dependencies. Read it next to this document, or run it to try
Podium against.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT** and **MAY** are used as in
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

- [Overview](#overview)
- [Conventions](#conventions)
- [Endpoints](#endpoints)
  - [`GET /server`](#get-server): server info and token check
  - [`POST /uploads`](#post-uploads): start an upload
  - [`PUT /uploads/{id}`](#put-uploadsid): send a chunk
  - [`GET /uploads/{id}`](#get-uploadsid): ask how much arrived
  - [`POST /uploads/{id}/complete`](#post-uploadsidcomplete): finish
  - [`DELETE /uploads/{id}`](#delete-uploadsid): cancel
- [Errors](#errors)
- [How clients behave](#how-clients-behave)
- [Implementing a server: checklist](#implementing-a-server-checklist)
- [Walkthrough with curl](#walkthrough-with-curl)
- [Versioning and future additions](#versioning-and-future-additions)

## Overview

```
Client                                              Server
  │  GET  /server                                     │   who are you, is my token good?
  │ ────────────────────────────────────────────────▶ │
  │  POST /uploads        { size, sha256, clip… }     │   open an upload session
  │ ────────────────────────────────────────────────▶ │
  │  ◀──────────── 201 { id, chunkSize, offset: 0 }   │
  │  PUT  /uploads/{id}   Content-Range: bytes 0-…    │   repeat until every byte is sent
  │ ────────────────────────────────────────────────▶ │
  │  ◀──────────────────────── 200 { offset }         │
  │  POST /uploads/{id}/complete                      │   verify, store, publish
  │ ────────────────────────────────────────────────▶ │
  │  ◀───────── 201 { clip: { id, url } }             │   the link Podium shows and copies
```

The user sets up a target in Podium with two things:

- **Server URL**: the protocol's *base URL*, such as `https://clips.example.com/api/podium`. Every path
  below is relative to it, so `GET /server` means `GET https://clips.example.com/api/podium/server`. The base
  URL MAY have a path, and clients remove a trailing slash before joining.
- **Access token**: an opaque string that the server issues to the user, for example on a settings page.
  The protocol doesn't say how tokens are made, scoped or revoked. A server MAY also run without tokens
  (a private LAN box, say).

## Conventions

### Transport

- Servers SHOULD use HTTPS. Podium accepts `http://` URLs, but warns the user that the token and their
  clips travel unencrypted.
- Request and response bodies are JSON (`Content-Type: application/json`) in UTF-8, except chunk bodies
  (`application/octet-stream`).
- Servers MUST ignore JSON fields they don't know, and clients do the same with responses. This is how the
  protocol grows without breaking anyone.
- Timestamps are ISO 8601 strings in UTC (`2026-10-24T19:04:11.000Z`). Sizes are integers in bytes.
  Durations are numbers in seconds.

### Headers clients send

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer <token>`. Sent on every request when the user gave a token. |
| `Podium-Upload-Version` | `1`: the protocol version the client speaks. |
| `User-Agent` | For example `Podium/0.2.0 (linux)`. Useful in logs, never needed for anything to work. |

### Authentication

- A server that needs a token MUST answer requests with a missing or wrong token with `401` and the
  error code `unauthorized`. It SHOULD also send `WWW-Authenticate: Bearer`.
- A token that's valid but isn't allowed to upload gets `403` and the error code `forbidden`.
- A server without tokens accepts every request and ignores `Authorization`.

### Upload ids

Upload ids are chosen by the server. They MUST be 1–128 characters from `A-Z a-z 0-9 - _ .`, so they can
go into a URL path as they are. They SHOULD be hard to guess (a random UUID is a good choice), and a
server MUST only accept chunks for an upload from the token that started it.

## Endpoints

### `GET /server`

Tells the client what the server is, what it accepts, and whether the token is good. Podium calls this
for **Test connection** in its settings, and at the start of every upload.

**Response `200`**

```json
{
  "protocol": "podium-upload",
  "versions": [1],
  "name": "Ion's clips",
  "account": { "name": "lucasion" },
  "maxFileSize": 4294967296,
  "accept": ["video/mp4", "video/x-matroska", "video/webm", "video/quicktime"]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `protocol` | yes | Always the string `"podium-upload"`. Clients use it to tell this apart from a random web page. |
| `versions` | yes | Protocol versions the server speaks. A client picks the highest one it also speaks, and refuses the target when there is none. |
| `name` | yes | A display name for the server. Podium suggests it as the target's name. |
| `account` | no | The account the token belongs to, as `{ "name": string }`. Use `null`, or leave it out, when there are no tokens. |
| `maxFileSize` | no | The largest file the server takes, in bytes. When it's set, clients don't start uploads for bigger files. |
| `accept` | no | The media types the server takes. Leaving it out means "any video". |

When a token is required but missing or wrong, the server answers `401` (see [Authentication](#authentication)).
That's how a client finds out the user's token is bad without trying an upload.

### `POST /uploads`

Opens an upload session for one file. No video bytes are sent yet. This lets the server turn down a
file that is too big, of the wrong type, or over quota before the client spends minutes sending it.

**Request**

```json
{
  "fileName": "Apex Legends 2026-10-24 21-04-11.mp4",
  "size": 187465321,
  "contentType": "video/mp4",
  "sha256": "9f2c…e1",
  "clip": {
    "id": "6f1d4c8e-3b9a-4a51-9a59-0c1f5c1f4e2a",
    "title": "Apex Legends 2026-10-24 21-04-11",
    "game": { "id": "steam:1172470", "name": "Apex Legends" },
    "recordedAt": "2026-10-24T19:04:11.000Z",
    "duration": 30.02,
    "width": 2560,
    "height": 1440,
    "fps": 60,
    "audioTracks": ["Desktop", "Microphone"]
  }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `fileName` | yes | The file's name on the user's disk. Servers MUST NOT use it as a path: treat it as a display hint only. |
| `size` | yes | Exact size of the file in bytes. |
| `contentType` | yes | The file's media type. |
| `sha256` | yes | SHA-256 of the whole file, as lowercase hex. Servers MAY check it on [complete](#post-uploadsidcomplete), and MAY use it to notice a file they already have. |
| `clip` | yes | What the client knows about the clip. Every field inside is optional for servers to use, and clients MAY leave any of them out. |
| `clip.id` | no | The clip's id in the client. It's stable across uploads of the same clip, so a server MAY use it to replace an earlier upload. |
| `clip.title` | no | The clip's name as the user sees it. |
| `clip.game` | no | `{ "id": string, "name": string }`, or `null` for clips with no game. Podium's game ids look like `steam:<appid>`, `app:<window class>` or `name:<lower-case name>`. |
| `clip.recordedAt` | no | When the clip was saved. |
| `clip.duration`, `clip.width`, `clip.height`, `clip.fps` | no | Basic video facts, so the server doesn't have to probe the file to show them. |
| `clip.audioTracks` | no | Audio track labels in stream order. Podium clips often carry several tracks (desktop audio and microphone kept apart). |

**Response `201`**: the session is open.

```json
{ "id": "u_5d1f0e7a9c", "chunkSize": 8388608, "offset": 0, "expiresAt": "2026-10-25T19:04:11.000Z" }
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | The upload id (see [Upload ids](#upload-ids)). |
| `chunkSize` | yes | The largest chunk the client may send in one `PUT`, in bytes (at least 1). Clients send chunks of exactly this size, except the last one. A server that wants the whole file in one request sets this to `size` or more. |
| `offset` | yes | How many bytes the server already has: `0` for a fresh upload. |
| `expiresAt` | no | When an unfinished session is thrown away. Servers SHOULD keep sessions for at least an hour. |

**Response `200`**: the server already has this file (for example, the same `sha256` from the same
account) and doesn't need it again. The body is the same as a [complete](#post-uploadsidcomplete)
response, `{ "clip": { … } }`, and the client is done.

Errors that make sense here: `400 invalid_request`, `401 unauthorized`, `403 forbidden`,
`413 too_large`, `415 unsupported_type`, `507 quota_exceeded`.

### `PUT /uploads/{id}`

Sends one chunk of the file.

```http
PUT /uploads/u_5d1f0e7a9c HTTP/1.1
Content-Type: application/octet-stream
Content-Length: 8388608
Content-Range: bytes 0-8388607/187465321
```

- `Content-Range` is `bytes <first>-<last>/<size>`, where `first` and `last` are inclusive byte positions
  in the file, as in HTTP range requests. The body holds exactly `last - first + 1` bytes.
- `first` MUST equal the server's current offset. Chunks are sent in order, one at a time, and are never
  sent twice once acknowledged.
- A chunk MUST NOT be bigger than `chunkSize`, and only the last chunk may be smaller.

**Response `200`**

```json
{ "offset": 8388608 }
```

`offset` is how many bytes the server has now. The server MUST store the chunk durably before it
answers, because the client treats those bytes as sent.

When `first` isn't the server's offset (a retry of a chunk that did arrive, say), the server answers
`409` with the error code `offset_mismatch` and its real offset next to the error:

```json
{ "error": { "code": "offset_mismatch", "message": "Expected the chunk at byte 8388608." }, "offset": 8388608 }
```

The client then continues from `offset`. A server that receives part of a chunk before the connection
breaks MAY keep those bytes (and report the larger offset) or drop them. Either way works, because
clients always resume from the offset the server reports.

Other errors: `400 invalid_request` (a malformed `Content-Range`, the wrong length, or a chunk that's too
big), `404 not_found` (unknown or expired upload).

### `GET /uploads/{id}`

Reports where an upload stands, so a client can resume after a network error or a timeout.

**Response `200`**

```json
{ "id": "u_5d1f0e7a9c", "offset": 8388608, "size": 187465321 }
```

`404 not_found` means the session expired or never existed. The client starts over with a new
`POST /uploads`.

### `POST /uploads/{id}/complete`

Says that every byte was sent. The server checks the upload, stores the clip and answers with where it
can be seen. The request has no body (or `{}`).

**Response `201`**

```json
{
  "clip": {
    "id": "c_81ab2f",
    "url": "https://clips.example.com/c/c_81ab2f",
    "thumbnailUrl": "https://clips.example.com/c/c_81ab2f/thumb.jpg"
  }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `clip.id` | yes | The clip's id on the server. |
| `clip.url` | no | Where people can watch the clip. This is the link Podium copies and opens. Leave it out when uploads aren't viewable (a backup target, say). |
| `clip.thumbnailUrl` | no | An image of the clip. |

If the server processes clips after they arrive (transcoding, for example), it SHOULD still answer right
away with a `url` that shows the clip once it's ready.

Errors that make sense here: `409 incomplete` (bytes are missing; include `"offset"` as for
`offset_mismatch`), `422 checksum_mismatch` (the bytes don't match `sha256`; the session is discarded),
`404 not_found`, `415 unsupported_type` (the content turned out not to be a video the server takes).

Completing an upload that's already complete SHOULD return the same `201` response again, because a
client whose connection dropped while waiting for the answer will ask twice.

### `DELETE /uploads/{id}`

Cancels an unfinished upload. The server throws away the bytes it received.

**Response `204`** with no body. An unknown id also gets `204` (or `404`): either way, the upload is gone.

## Errors

Every error response is JSON with an `error` object:

```json
{ "error": { "code": "too_large", "message": "Clips can be at most 4 GB on this server." } }
```

- `message` is a readable sentence for the user. Podium shows it as it is ("Upload failed: Clips can be at
  most 4 GB on this server."), so say what went wrong and, when you can, what to do about it.
- `code` is for programs. Use one from the table below when it fits. A server MAY invent others (prefix
  them with your server's name, like `myserver_banned`), and clients treat unknown codes by their HTTP
  status.
- A response that isn't JSON (a proxy's HTML error page, say) is still an error. Clients fall back to the
  HTTP status text.

| Status | Code | When |
| --- | --- | --- |
| 400 | `invalid_request` | A missing or malformed field or header. |
| 401 | `unauthorized` | The token is missing or wrong. |
| 403 | `forbidden` | The token can't do this. |
| 404 | `not_found` | Unknown or expired upload id. |
| 409 | `offset_mismatch` | A chunk didn't start at the server's offset. Include `"offset"`. |
| 409 | `incomplete` | `complete` was called before every byte arrived. Include `"offset"`. |
| 413 | `too_large` | The file is bigger than the server takes. |
| 415 | `unsupported_type` | The server doesn't take this kind of file. |
| 422 | `checksum_mismatch` | The bytes don't match the `sha256` from `POST /uploads`. |
| 429 | `rate_limited` | Slow down. Send `Retry-After` (in seconds). |
| 5xx | `server_error` | Anything unexpected. Clients retry these. |
| 507 | `quota_exceeded` | The account is out of space. |

## How clients behave

This is what Podium does. Servers can count on it, and other clients SHOULD do the same.

- **One file per session**, chunks in order, one request at a time per session.
- **Retries.** A network error, a timeout, `408`, `429`, `502`, `503`, `504` or any other `5xx` is retried
  up to 6 times, waiting about 1, 2, 5, 10, 30 and then 60 seconds (or `Retry-After`, when the server sends
  it). Before retrying a `PUT`, the client asks `GET /uploads/{id}` for the offset and continues from there.
  Every other `4xx` fails the upload and shows the server's `message`.
- **A `404` on a session, or `422 checksum_mismatch`,** makes the client start over with a fresh
  `POST /uploads`. That happens at most once per upload, and the next such error fails it.
- **Cancelling** sends `DELETE /uploads/{id}` and doesn't wait for the answer.
- **Timeouts.** A request that makes no progress for 60 seconds (no bytes go out and no response comes
  back) counts as a network error. A slow connection can take longer than that to send a chunk, as long
  as bytes keep moving. Servers that process clips on `complete` SHOULD answer within 60 seconds.
- **Redirects** are followed for `GET /server` only. Upload requests are never redirected.
- The client remembers `clip.id` and `clip.url` from the complete response, shows the link next to the
  clip and, when the user asks for it, copies it to the clipboard.

## Implementing a server: checklist

The smallest server that works with Podium:

1. `GET /server` returns `protocol`, `versions: [1]` and `name`, and `401` when the token is wrong.
2. `POST /uploads` checks the size against your limit, creates a session with a random id, and returns
   `{ id, chunkSize, offset: 0 }`. Set `chunkSize` to the file's `size` if you'd rather receive it in one go.
3. `PUT /uploads/{id}` checks that `Content-Range` starts at the session's offset, appends the body to a
   temporary file, and returns the new `offset`.
4. `GET /uploads/{id}` returns `{ id, offset, size }`.
5. `POST /uploads/{id}/complete` checks that `offset === size` (and the SHA-256, if you like), moves the
   file to its final place, and returns `{ clip: { id, url } }`.
6. `DELETE /uploads/{id}` deletes the temporary file.
7. Errors are `{ "error": { "code", "message" } }`.

Things that are easy to get wrong:

- **Don't trust `fileName`** as a path. Store files under names you choose.
- **Durability.** Answer a `PUT` only after the chunk is written. A client that hears `200` won't send
  those bytes again.
- **Body size limits** in your reverse proxy (`client_max_body_size` in nginx) must allow at least one
  `chunkSize`, plus some room.
- **Timeouts** in your reverse proxy must allow a chunk to arrive over a slow connection. 8 MB chunks are
  a good balance between few requests and little lost work per failure.
- **Clean up** sessions that are never completed after `expiresAt`.

## Walkthrough with curl

With the reference server running (`PODIUM_UPLOAD_TOKEN=secret node docs/upload-reference-server.ts`, or
`deno run -A docs/upload-reference-server.ts`):

```sh
BASE=http://localhost:8787
AUTH="Authorization: Bearer secret"
FILE=clip.mp4
SIZE=$(stat -c %s "$FILE")
SHA=$(sha256sum "$FILE" | cut -d' ' -f1)

curl -s -H "$AUTH" $BASE/server

ID=$(curl -s -H "$AUTH" -H 'Content-Type: application/json' $BASE/uploads \
  -d "{\"fileName\":\"$FILE\",\"size\":$SIZE,\"contentType\":\"video/mp4\",\"sha256\":\"$SHA\",\"clip\":{}}" \
  | sed -E 's/.*"id":"([^"]+)".*/\1/')

# One chunk with the whole file (the reference server's chunk size is 8 MB, so use a small file here).
curl -s -X PUT -H "$AUTH" -H 'Content-Type: application/octet-stream' \
  -H "Content-Range: bytes 0-$((SIZE - 1))/$SIZE" --data-binary @"$FILE" $BASE/uploads/$ID

curl -s -X POST -H "$AUTH" $BASE/uploads/$ID/complete
```

## Versioning and future additions

- This document is version `1`. Additions that old clients and servers can ignore (a new optional field,
  a new error code) keep the version at `1` and are listed below. A change that would break an
  implementation of version 1 gets a new version, and servers can list both in `versions` while clients
  move over.
- Clients send `Podium-Upload-Version` so a server that speaks several versions knows which one it's
  talking to. Servers that only speak version 1 can ignore the header.
- Ideas for later versions, not part of the protocol yet: deleting and renaming uploaded clips from the
  client, uploading a thumbnail with the clip, and visibility settings (public, unlisted, private).

### Changes

- **1** (2026-10): first version.
