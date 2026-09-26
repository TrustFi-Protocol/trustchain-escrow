# API Response Envelope

TrustFi clients should treat the response envelope as the stable contract around
endpoint payloads. The payload shape may vary by endpoint, but the envelope keys
stay the same for backend, frontend, and mobile consumers.

## Standard Shape

```json
{
  "success": true,
  "data": {},
  "error": null,
  "meta": {
    "correlationId": "req_123",
    "pagination": {
      "limit": 25,
      "nextCursor": null,
      "previousCursor": null,
      "total": null,
      "hasMore": false
    }
  }
}
```

Use `shared/responseEnvelope.js` when a service, UI adapter, or mobile client
needs to construct or normalize this shape.

## Success Responses

- `success` is `true`.
- `data` contains the resource or collection returned by the endpoint.
- `error` is always `null`.
- `meta.correlationId` carries the backend request correlation id when present.
- `meta.pagination` is present only on cursor or page based collection endpoints.

## Error Responses

```json
{
  "success": false,
  "data": null,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request payload.",
    "details": {}
  },
  "meta": {
    "correlationId": "req_123"
  }
}
```

Clients should show `error.message` to users only after mapping known codes to
approved product copy. Raw validation details are for form fields and logs.

## Bypassed Endpoints

The envelope is not required for:

- health checks that must return plain `200 OK` for infrastructure probes
- file downloads and generated PDFs
- webhook callbacks where the integrator contract already defines the response
- streaming or websocket messages

New exceptions should be documented with the owning route.
