# @pipeworx/ct-dmv

Connecticut DMV MCP — electric-vehicle registrations at vehicle level, aggregated on demand by
town, make, model, model year or body type.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

- `ct_dmv_ev_registrations(group_by?, city?, make?, model?, model_year?, vehicle_type?, limit?)`
  — counts of registered electric vehicles. Answers "how many EVs are registered in
  Connecticut", "how many Teslas are registered in Connecticut", "which Connecticut town has
  the most EVs", "most popular EV models in Connecticut".

`group_by` accepts `city` (default), `make`, `model`, `model_year`, `vehicle_type`, `body`,
`fuel`, `color`, `plate_type`, `usage`, `category`.

## Auth

Keyless.

## Vintage — read this before quoting a number

The file is a **snapshot taken 2025-02-28**. Connecticut has not refreshed it since, so it
covers the electric vehicles registered as of February 2025 and a count read as "today" is
wrong by more than a year. `as_of` carries the refresh date, `covers` states the period in
words, and a `note` repeats it on every response.

## Grain

One row per registered vehicle — 60,489 of them, each with plate type, owner town, weight,
colour, model year and expiry. The pack never returns those individual records; it aggregates
server-side with `$select=<col>,count(1)&$group=<col>` and returns counts.

`sum_of_returned_rows` is the sum of the rows actually returned, and `truncated` says whether
`limit` cut the list off. There are ~170 Connecticut towns and hundreds of models, so a default
call is usually truncated — which is why no field claims to be a statewide EV total.

Verified live 2026-07-29, `group_by="make"`: Tesla 21,405 · Toyota 5,759 · Jeep 5,302 ·
Chevrolet 2,982 · KIA 2,916. Total rows in the file: 60,489.

## Data sources

- `https://data.ct.gov/resource/y7ky-5wcz.json` — CT DMV "Electric Vehicle Registration Data".
- `https://data.ct.gov/api/views/y7ky-5wcz.json` — `rowsUpdatedAt`, used for `as_of`.

Column names are lowercase and unseparated: `primarycustomercity`, `vehiclemake`,
`vehiclemodel`, `vehicleyear`, `vehicletype`, `vehiclebody`, `fuelcode`, `platetype`,
`registrationusage`. Town names are stored upper-case (`WEST HARTFORD`) while makes are mixed
case (`Tesla`, `KIA`), so both are matched with `upper(col) like`.

**Rejected while building:** `apne-w8c6`, published as "Licensed Automobile Dealers And
Repairers", sounds like a dealer locator but holds **138 manufacturer licences**, mostly held
by out-of-state RV and trailer makers — 23 in Indiana, 18 in California, 2 in Connecticut, and
every row is `MANUFACTURER LICENSE`. It cannot answer "find a licensed dealer or repairer near
me", so no tool wraps it. Do not re-probe it expecting a dealer list.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ct-dmv": {
      "url": "https://gateway.pipeworx.io/ct-dmv/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ct-dmv/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ct Dmv data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ct_dmv_ev_registrations \
  -H 'Content-Type: application/json' \
  -d '{"group_by":"make","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ct_dmv_ev_registrations`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.
