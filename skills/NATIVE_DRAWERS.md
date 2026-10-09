# Native iOS screens for custom skills

Custom skill tools, servers, credentials, watchers, permissions, and chat routing
continue to run on OE. A native screen is an optional **data description** beside
the browser drawer. It does not contain Swift, JavaScript, HTML, or executable
expressions. The iOS app renders it with its own native controls.

Use `skill_read_drawer`, then `skill_update_drawer` with `expected_version` and the
complete existing drawer plus `nativeUI`. Do not edit `plugins/` directly. The
same ownership, atomic update, validation, and hot reload apply. Omitting
`nativeUI` preserves it for compatibility with older editors; set it to `null`
to remove it. The existing HTML drawer remains the website's presentation.

```json
{
  "version": 1,
  "screens": [{
    "id": "items",
    "title": "My items",
    "request": { "path": "/api/usr_example/items" },
    "presentation": "list",
    "collection": "items",
    "titleField": "name",
    "subtitleField": "status",
    "fields": ["name", "description", "status"],
    "create": {
      "title": "Add item",
      "method": "POST",
      "request": { "path": "/api/usr_example/items" },
      "fields": [
        { "key": "name", "label": "Name", "type": "text", "required": true },
        { "key": "description", "label": "Description", "type": "multiline" }
      ]
    },
    "actions": [{
      "title": "Delete item",
      "method": "DELETE",
      "request": { "path": "/api/usr_example/items/{id}" },
      "destructive": true,
      "confirmation": "Delete this item?"
    }]
  }]
}
```

Replace `example` with the exact skill id. Every request must stay under the
skill's generated API prefixes (the same prefixes supplied to its server as
`cfg.apiPrefixes`). Requests cannot specify an origin, headers, session token,
cookies, or a core OE route. The app supplies authentication for the selected
account; server authorization remains authoritative.

- `version` is `1` or `2`. Both retain a 64 KiB description limit and 1–12 root
  screens. Version 2 additionally allows up to 48 screens total (including action
  results), nested at most three levels below the root. IDs are unique across
  the entire description. These limits apply per skill, not per account.
- A screen has a unique `id`, `title`, GET `request`, and `presentation` (`list`
  or `record`). `collection` is a dotted path to a list, omitted for a root array.
  Use stable `id` values in item records. `titleField`, `subtitleField`, and
  `fields` select readable data. No data is evaluated as HTML or JavaScript.
- A request contains `path` and optional `query` object. In **action** paths,
  `{id}` or `{nested.field}` substitutes one percent-encoded row value. In body
  or query values, `{"$row":"nested.field"}` references the selected row. Whole
  values are bound as JSON; this is not string templating or script execution.
- `create` and `actions` use `title`, `method` (`POST`, `PUT`, `PATCH`, `DELETE`),
  `request`, optional `body`, `fields`, `confirmation`, and `destructive`.
  Plain actions request confirmation. Form actions require explicit submission.
  Results are displayed natively, and failed HTTP responses remain failures.
- Fields have `key`, `label`, and `type`: `text`, `multiline`, `secret`, `number`,
  `toggle`, `choice`, or `multiChoice`. Optional fields: `required`, `initial`,
  `help`, `choices` (`[{"value":"id","label":"Name"}]`). Secret controls clear
  after submission and are never stored in chat history by the app.
- Keep long operations asynchronous in your backend. Version 1 supports manual
  status refresh; version 2 can open and poll a returned job as described below.
  Specialized interactive canvases still need a shared renderer extension.
  Do not hardcode a particular user's skill into the app or disguise HTML as
  native content.
- Return standard JSON and meaningful HTTP error statuses. New native forms and
  lists using these controls do **not** require a new iPhone build. A new kind of
  control does require an app update. Unsupported screens show a clear message;
  the skill's tools remain callable from native Chat.

The iOS `NATIVE_EXTENSIONS.md` records client fixtures and acceptance checks.

## Version 2 additions

All version 1 fields still work. Select `version: 2` before using these additions:

- A screen's `children` array contains native screens opened from a selected
  record. Their requests and create forms bind `$row` and path placeholders to
  that parent record. `detailRequest` is an optional own-namespace GET request
  for a selected row. `idField` selects its stable identity (default `id`).
- `presentation: "table"` displays the selected `fields` as labeled values in
  each row. It works with the same detail, action and form controls as a list.
- `refreshSeconds` is an integer from 5 to 300. The app polls while that screen
  is visible in the foreground, suspending during editing. Lists pause polling
  after loading extra pages so those pages are not discarded; pulling to refresh
  returns to the first page and resumes polling.
- `nextPageField` names the response's next cursor/offset; `pageParameter`
  names its GET query parameter (default `offset`). Return null or an empty string
  to end paging. `searchParameter` names the server-side search query parameter.
- `download: {request, filenameField}` adds authenticated native preview/share
  for the selected row. `upload: {request}` adds an explicit file picker and
  multipart POST with a single `file` part. These requests use the same namespace
  and no-redirect rules as every other native request.
- A choice or multiChoice field can use a GET `source` request. Its optional
  `sourceCollection`, `valueField` and `labelField` select the returned list,
  option ID and title (defaults: root array, `id`, `name`). Source requests bind
  to the selected parent/row; they cannot access core OE or another skill.
- Additional form types: `nullableNumber` and `nullableDate` explicitly send
  null when cleared; `date` sends an ISO timestamp; `strings` turns one item per
  line into an array; `json` and `secretJSON` parse JSON; `file` sends base64;
  `jsonFile` parses a selected JSON file. Blank optional JSON/secrets are omitted.
  To explicitly clear JSON, enter `null` or the appropriate empty object/array.
- An action/create form can define `result`, a complete screen description.
  Its request binds to the successful mutation response, allowing the returned
  job ID to open a status screen. Nothing submits again just to view progress.

For example, a row action can return `{ "jobId": "job_123" }` and describe:

```json
{
  "title": "Start job",
  "method": "POST",
  "request": { "path": "/api/usr_example/items/{id}/run" },
  "result": {
    "id": "job_status",
    "title": "Job status",
    "request": { "path": "/api/usr_example/jobs/{jobId}" },
    "presentation": "record",
    "fields": ["state", "progress", "message"],
    "refreshSeconds": 5
  }
}
```

GET endpoints must be read-only. Status responses should describe completion or
failure; stopping/cancelling a job must be an explicit action. Arbitrary code,
HTML, OAuth credentials, arbitrary headers and external API origins remain
unsupported in a native description. Server ownership checks remain mandatory.
