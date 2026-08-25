/**
 * Ask Ada ONE question through the live /chat endpoint and print the answer,
 * the tools she called, and the done frame. The parity loop uses it to put the
 * founder's web question to terminal-grade Ada (the internal door: no scope
 * claim, full toolset) and compare the two answers literally.
 *
 *   pnpm exec tsx scripts/ask-ada.ts --client BFM "How is the account doing?"
 *   pnpm exec tsx scripts/ask-ada.ts --scope BFM  "How is the account doing?"   # the customer door
 *
 * Reads ADA_ASSIST_SECRET (X-Assist-Key) and, for --scope, ADA_SCOPE_SIGNING_SECRET
 * from the environment, falling back to /root/ada-console-assist.env, the
 * service's own env file. Neither value is ever printed.
 */
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

function envFrom(name: string): string {
  if (process.env[name]) return process.env[name] as string;
  try {
    for (const line of readFileSync("/root/ada-console-assist.env", "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && m[1] === name) return m[2].replace(/^"|"$/g, "");
    }
  } catch {}
  return "";
}

const argv = process.argv.slice(2);
const flag = (f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] ?? "" : "");
const client = flag("--client").toUpperCase();
const scope = flag("--scope").toUpperCase();
const question = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--client" && argv[i - 1] !== "--scope").join(" ").trim();
if (!question || (!client && !scope)) {
  console.error("usage: ask-ada.ts (--client CODE | --scope CODE) \"question\"");
  process.exit(2);
}
const assistKey = envFrom("ADA_ASSIST_SECRET");
if (!assistKey) { console.error("ADA_ASSIST_SECRET not found"); process.exit(2); }

function mintScopeClaim(code: string): string {
  const secret = envFrom("ADA_SCOPE_SIGNING_SECRET");
  if (!secret) { console.error("ADA_SCOPE_SIGNING_SECRET not found"); process.exit(2); }
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ client_scope: code, user_id: "parity-ask", iat: now, exp: now + 300 })).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

const body: Record<string, unknown> = { question, session_id: `parity-${randomUUID()}` };
if (scope) { body.client_scope = scope; body.scope_claim = mintScopeClaim(scope); }
else body.context = { client_code: client };

const started = Date.now();
const res = await fetch(process.env.ADA_CHAT_URL ?? "http://localhost:8092/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Assist-Key": assistKey },
  body: JSON.stringify(body),
});
if (!res.ok || !res.body) { console.error(`/chat HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`); process.exit(1); }

let text = "";
const tools: string[] = [];
let done: Record<string, unknown> | null = null;
let capability: Record<string, unknown> | null = null;
let buffer = "";
const reader = res.body.getReader();
const decoder = new TextDecoder();
function handle(frame: string) {
  let event = "message"; let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return;
  let p: Record<string, unknown>; try { p = JSON.parse(data); } catch { return; }
  if (event === "text" && typeof p.text === "string") text += p.text;
  else if (event === "reset") text = "";
  else if (event === "tool") tools.push(String(p.label ?? p.name ?? p.tool ?? JSON.stringify(p)).slice(0, 80));
  else if (event === "capability") capability = p;
  else if (event === "done") done = p;
  else if (event === "error") console.error("error frame:", JSON.stringify(p).slice(0, 300));
}
for (;;) {
  const { value, done: end } = await reader.read();
  if (end) break;
  buffer += decoder.decode(value, { stream: true });
  let idx: number;
  while ((idx = buffer.indexOf("\n\n")) >= 0) { handle(buffer.slice(0, idx)); buffer = buffer.slice(idx + 2); }
}
buffer += decoder.decode(); if (buffer.trim()) handle(buffer);

const door = scope ? `customer door (scope ${scope})` : `internal door (client ${client})`;
console.log(`# ${door} · ${((Date.now() - started) / 1000).toFixed(1)} s`);
if (capability) console.log(`# capability: ${JSON.stringify(capability)}`);
console.log(`# tools (${tools.length}): ${tools.join(" · ") || "none"}`);
console.log(`# done: ${done ? JSON.stringify(done) : "NO DONE FRAME (stream ended early)"}`);
console.log("");
console.log(text.trim());
