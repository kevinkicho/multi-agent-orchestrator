#!/usr/bin/env bun
/**
 * One-off diagnostic — send a minimum-cost chat request to opencode-go and
 * dump every response header. The question we're trying to answer: does
 * opencode.ai return rate-limit / quota headers we could surface in the
 * boot-check probe, or is the 429 body the only signal we get?
 *
 * Run:  bun run scripts/probe-opencode-headers.ts
 *
 * Expects OPENCODE_GO_API_KEY in .env (Bun autoloads it).
 *
 * This is intentionally NOT wired into the test suite — it's a throwaway
 * diagnostic kept in scripts/ for reference. Delete after the investigation.
 */

const API_KEY = process.env.OPENCODE_GO_API_KEY
if (!API_KEY) {
  console.error("OPENCODE_GO_API_KEY missing — can't probe. Add it to .env.")
  process.exit(1)
}

const ENDPOINT = "https://opencode.ai/zen/go/v1/chat/completions"

async function probe(label: string, body: unknown) {
  console.log(`\n=== ${label} ===`)
  const started = Date.now()
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
    })
    const elapsed = Date.now() - started
    console.log(`HTTP ${res.status} ${res.statusText} (${elapsed}ms)`)
    console.log(`--- response headers ---`)
    // Dump every header, alphabetized, so we can eyeball rate-limit keys.
    const entries: Array<[string, string]> = []
    res.headers.forEach((value, key) => entries.push([key, value]))
    entries.sort(([a], [b]) => a.localeCompare(b))
    for (const [k, v] of entries) {
      console.log(`  ${k}: ${v}`)
    }
    const text = await res.text()
    // Truncate body — we just want to see the error shape, not the full SSE stream.
    const preview = text.length > 500 ? text.slice(0, 500) + "…" : text
    console.log(`--- body preview (${text.length} bytes) ---`)
    console.log(preview)
  } catch (err) {
    console.log(`probe failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

await probe("minimal chat completion (expect quota 429 or ok)", {
  model: "glm-5.1",
  messages: [{ role: "user", content: "ping" }],
  max_tokens: 1,
  temperature: 0,
})

// Also try a plain GET on a few endpoints opencode-style APIs sometimes expose
// for usage introspection. These are guesses — the point is to see whether
// any of them resolve to something useful or all 404.
for (const path of ["/v1/usage", "/v1/account", "/usage", "/account"]) {
  const url = `https://opencode.ai/zen/go${path}`
  console.log(`\n=== GET ${url} ===`)
  try {
    const res = await fetch(url, { headers: { "Authorization": `Bearer ${API_KEY}` } })
    console.log(`HTTP ${res.status} ${res.statusText}`)
    const t = await res.text()
    const preview = t.length > 300 ? t.slice(0, 300) + "…" : t
    console.log(preview)
  } catch (err) {
    console.log(`probe failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
