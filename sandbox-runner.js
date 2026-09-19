/* =============================================================
   AI App Factory — Sandbox Runner (Phase 2, real execution)
   -------------------------------------------------------------
   This small server receives the Builder's generated files, runs
   them inside an isolated E2B cloud sandbox, and returns the real
   build/test logs to the PWA. The E2B key lives ONLY here on the
   server — never in the browser app.

   WHY A SERVER: a static single-file PWA on GitHub Pages/Netlify
   cannot run containers or shell commands. This runner is the
   piece that gives the Builder real execution. Deploy it on any
   Node host (Railway, Render, Fly.io, a small VPS, etc.).

   DEPLOY
   ------
   1. Files:  sandbox-runner.mjs  +  package.json below
        package.json:
        {
          "name": "aiaf-sandbox-runner",
          "version": "1.0.0",
          "type": "module",
          "scripts": { "start": "node sandbox-runner.mjs" },
          "dependencies": { "express": "^4.19.2", "e2b": "^1.4.0" }
        }
   2. npm install
   3. Set environment variables:
        E2B_API_KEY   = your key from https://e2b.dev/dashboard/keys
        RUNNER_SECRET = any long random string (paste the SAME value
                        into the PWA's "Runner shared secret" field)
        PORT          = optional (default 8080)
   4. npm start  →  point the PWA "Sandbox runner URL" at
        https://YOUR-HOST/run

   CONTRACT (matches the PWA)
   --------------------------
   POST /run   JSON body:
     { "secret": string,
       "commands": [string],
       "files": [{ "path": string, "content": string }] }
   Response JSON:
     { "success": boolean,
       "results": [{ "cmd": string, "stdout": string,
                     "stderr": string, "exitCode": number }] }

   SAFETY: this runs AI-generated code. E2B isolates each run in a
   fresh microVM that is killed afterwards. The shared secret keeps
   the endpoint from being called by anyone. Keep limits sane.
   ============================================================= */

import express from "express";
import { Sandbox } from "e2b";

const app = express();
app.use(express.json({ limit: "8mb" }));

const SECRET = process.env.RUNNER_SECRET || "";
const PORT = process.env.PORT || 8080;
const MAX_FILES = 60;
const CMD_TIMEOUT_MS = 120000;   // 2 min per command
const BOX_TIMEOUT_MS = 300000;   // 5 min per sandbox

/* CORS — the PWA calls this from the browser. Origin is open but
   every call must carry the shared secret in the body. */
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (req, res) => res.json({ ok: true, service: "aiaf-sandbox-runner" }));

app.post("/run", async (req, res) => {
  const body = req.body || {};

  if (!SECRET || body.secret !== SECRET) {
    return res.status(401).json({ error: "Unauthorized: bad or missing secret." });
  }
  const files = Array.isArray(body.files) ? body.files : [];
  const commands = Array.isArray(body.commands) ? body.commands : [];
  if (files.length === 0) return res.status(400).json({ error: "No files provided." });
  if (files.length > MAX_FILES) return res.status(400).json({ error: "Too many files." });

  let sandbox = null;
  const results = [];
  let success = true;

  try {
    sandbox = await Sandbox.create({ timeoutMs: BOX_TIMEOUT_MS });

    // write every file into the sandbox (creates parent dirs)
    for (const f of files) {
      if (!f || typeof f.path !== "string") continue;
      const path = f.path.startsWith("/") ? f.path : "/home/user/" + f.path;
      await sandbox.files.write(path, String(f.content || ""));
    }

    // run each command from the project root, capturing real output
    for (const cmd of commands) {
      if (typeof cmd !== "string" || !cmd.trim()) continue;
      let out = { stdout: "", stderr: "", exitCode: 0 };
      try {
        const r = await sandbox.commands.run(cmd, {
          cwd: "/home/user",
          timeoutMs: CMD_TIMEOUT_MS
        });
        out.stdout = r.stdout || "";
        out.stderr = r.stderr || "";
        out.exitCode = typeof r.exitCode === "number" ? r.exitCode : 0;
      } catch (e) {
        // E2B throws on non-zero exit — capture it as a real failure
        out.stdout = e.stdout || "";
        out.stderr = e.stderr || e.message || "command failed";
        out.exitCode = typeof e.exitCode === "number" ? e.exitCode : 1;
      }
      if (out.exitCode !== 0) success = false;
      results.push({ cmd: cmd, stdout: out.stdout, stderr: out.stderr, exitCode: out.exitCode });
    }

    res.json({ success, results });
  } catch (err) {
    res.status(500).json({ error: "Sandbox error: " + (err && err.message ? err.message : String(err)) });
  } finally {
    if (sandbox) { try { await sandbox.kill(); } catch (e) {} }
  }
});

app.listen(PORT, () => console.log("AI App Factory sandbox runner listening on :" + PORT));
