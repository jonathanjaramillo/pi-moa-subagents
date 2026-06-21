/**
 * pi-moa-subagents — Mixture-of-Experts Bug Diagnosis
 *
 * Points multiple locally-hosted or API models at a bug description, has each
 * independently investigate the codebase sequentially (single-GPU VRAM limits),
 * then synthesizes findings into either an executive summary or an
 * implemented-and-tested fix.
 *
 * Requires: pi-subagents (external prerequisite — not bundled)
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Container, Text, SettingsList, type SettingItem } from "@earendil-works/pi-tui";

// ── Paths ───────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const INVESTIGATOR_MD_PATH = join(__dirname, "assets", "investigator.md");

// ── Scaffolding ─────────────────────────────────────────────────────────
async function ensureAgentInstalled() {
  const target = join(getAgentDir(), "agents", "investigator.md");
  if (existsSync(target)) return; // never overwrite user customizations
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(INVESTIGATOR_MD_PATH, "utf-8"), "utf-8");
}

// ── Helpers ─────────────────────────────────────────────────────────────
function sanitizeForFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9_\-]/g, "_");
}

function modelKey(model: Model<unknown>): string {
  return `${model.provider}/${model.id}`;
}

/** Filter available models to only those explicitly configured in models.json */
function getConfiguredModels(available: Model<unknown>[]): Model<unknown>[] {
  const modelsJsonPath = join(getAgentDir(), "models.json");
  if (!existsSync(modelsJsonPath)) return available;

  try {
    const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8")) as {
      providers?: Record<string, { models?: Array<{ id: string }> }>;
    };
    const configuredPairs = new Set<string>();
    for (const [provider, providerConfig] of Object.entries(config.providers || {})) {
      if (!providerConfig?.models) continue; // no explicit model list → keep all
      for (const modelDef of providerConfig.models) {
        configuredPairs.add(`${provider}/${modelDef.id}`);
      }
    }
    return available.filter((m) => configuredPairs.has(modelKey(m)));
  } catch {
    return available; // malformed JSON → fall back to all available
  }
}

// ── Extension factory ───────────────────────────────────────────────────
export default function moaSubagentsExtension(pi: ExtensionAPI) {
  // Scaffold investigator agent on session start
  pi.on("session_start", async (_event, _ctx) => {
    await ensureAgentInstalled();
  });

  // Register /moa-subagents command
  pi.registerCommand("moa-subagents", {
    description: "Mixture-of-experts bug diagnosis with multiple models",
    handler: async (args, ctx) => {
      // ── Get or prompt for bug description ─────────────────────────────
      let description = args?.trim() ?? null;

      if (!description && ctx.mode === "tui") {
        description = await ctx.ui.editor(
          "Bug Description",
        );
        if (!description) {
          ctx.ui.notify("Bug description cancelled. Aborting.", "warning");
          return;
        }
      } else if (!description) {
        ctx.ui.notify("Usage: /moa-subagents <bug description>", "warning");
        return;
      }

      // ── Prerequisite guard ────────────────────────────────────────────
      if (!pi.getAllTools().some((t) => t.name === "subagent")) {
        ctx.ui.notify(
          "pi-moa-subagents requires pi-subagents.\nInstall: pi install npm:pi-subagents",
          "error",
        );
        return;
      }

      // ── Step 1: Investigator model selection (multi-select) ────────────
      const allModels = getConfiguredModels(ctx.modelRegistry.getAvailable());
      if (allModels.length === 0) {
        ctx.ui.notify("No models configured. Aborting.", "error");
        return;
      }

      const selected = new Set<number>();

      await ctx.ui.custom<undefined>((tui, theme, _kb, done) => {
        const items: SettingItem[] = allModels.map((m, i) => ({
          id: String(i),
          label: `${m.provider}/${m.id}${ctx.modelRegistry.hasConfiguredAuth(m) ? "" : " (no auth)"}`,
          currentValue: "available",
          values: ["selected", "available"],
        }));

        const container = new Container();
        container.addChild(new Text(theme.fg("accent", theme.bold("Select Investigator Models"))));
        container.addChild(new Text(theme.fg("dim", "↑↓ navigate  space toggle  Esc confirm")));

        const list = new SettingsList(
          items,
          Math.min(items.length + 2, 15),
          getSettingsListTheme(),
          (id, value) => {
            if (value === "selected") selected.add(Number(id));
            else selected.delete(Number(id));
          },
          () => done(undefined), // close / Esc
        );
        container.addChild(list);

        return {
          render(w: number) { return container.render(w); },
          invalidate() { container.invalidate(); },
          handleInput(data: string) { list.handleInput(data); tui.requestRender(); },
        };
      });

      if (selected.size === 0) {
        ctx.ui.notify("No investigator models selected. Aborting.", "warning");
        return;
      }
      const investigatorModels = [...selected].map((i) => allModels[i]);

      // ── Step 2: Synthesis model selection (single select) ──────────────
      const synthOptions = allModels.map((m) => {
        const auth = ctx.modelRegistry.hasConfiguredAuth(m) ? "" : " (no auth)";
        return `${modelKey(m)}${auth}`;
      });

      const synthValue = await ctx.ui.select("Select Synthesis Model", synthOptions);
      if (!synthValue) {
        ctx.ui.notify("No synthesis model selected. Aborting.", "warning");
        return;
      }
      // Strip trailing " (no auth)" suffix if present
      const cleanKey = synthValue.replace(" (no auth)", "");
      const synthSlashIdx = cleanKey.indexOf("/");
      const synthProvider = cleanKey.slice(0, synthSlashIdx);
      const synthId = cleanKey.slice(synthSlashIdx + 1);
      const synthesisModel = allModels.find((m) => m.provider === synthProvider && m.id === synthId);
      if (!synthesisModel) {
        ctx.ui.notify("Selected synthesis model not found. Aborting.", "error");
        return;
      }

      // ── Step 3: Implement-and-test toggle ──────────────────────────────
      const autoImplement = await ctx.ui.confirm(
        "Auto-Implement & Test",
        "Automatically implement and test a fix, or just give an executive summary?\n\nYes  = implement + test\nNo   = summary only",
      );

      // ── Build instruction and hand off via sendUserMessage ─────────────
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const diagnoseDir = `diagnose/${ts}`;
      mkdirSync(diagnoseDir, { recursive: true });

      // Build per-model task JSON fragments
      const taskEntries = investigatorModels.map((m) => {
        const file = `${sanitizeForFilename(m.provider)}_${sanitizeForFilename(m.id)}.md`;
        return `    { agent: "investigator", model: "${modelKey(m)}", task: ${JSON.stringify(description)}, output: "${diagnoseDir}/${file}" }`;
      }).join(",\n");

      // Output file paths for synthesis step
      const outputFiles = investigatorModels.map((m) => {
        const file = `${sanitizeForFilename(m.provider)}_${sanitizeForFilename(m.id)}.md`;
        return `  - ${diagnoseDir}/${file}`;
      }).join("\n");

      let instruction = "";
      instruction += "# MOA Bug Diagnosis\n";
      instruction += "\n";
      instruction += "I need you to orchestrate a mixture-of-experts bug investigation. Follow these steps:\n";
      instruction += "\n";
      instruction += "## Step 1: Launch Investigator Agents\n";
      instruction += "\n";
      instruction += "Run parallel investigator agents with `concurrency: 1` (sequential execution, single-GPU constraint). Each investigates independently from fresh context.\n";
      instruction += "\n";
      instruction += "```\n";
      instruction += `subagent({\n`;
      instruction += `  tasks: [\n${taskEntries}\n`;
      instruction += `  ],\n`;
      instruction += `  concurrency: 1,\n`;
      instruction += `  context: "fresh",\n`;
      instruction += `  async: false\n`;
      instruction += `})\n`;
      instruction += "```\n";
      instruction += "\n";
      instruction += "## Step 2: Synthesize Findings\n";
      instruction += "\n";
      instruction += "Run the synthesis agent in **foreground mode** (`async: false`). Investigators wrote their reports to:\n";
      instruction += "\n";
      instruction += "Investigator output files:\n";
      instruction += `${outputFiles}\n`;
      instruction += "\n";
      instruction += "```\n";
      instruction += `subagent({\n`;
      instruction += `  model: "${modelKey(synthesisModel)}",\n`;
      instruction += `  context: "fresh",\n`;
      instruction += `  async: false,\n`;
      instruction += `  task: \"Read all investigator report files listed above and produce a consolidated diagnosis. Produce: root cause, evidence from each model's investigation, confidence level assessment, and recommended fix direction.\"\n`;
      instruction += `})\n`;
      instruction += "```\n";

      if (autoImplement) {
        instruction += "\n## Step 3: Implement and Test the Fix\n";
        instruction += "\n";
        instruction += `If synthesis identifies a clear fix direction, hand off to worker agent with model "${modelKey(synthesisModel)}":\n`;
        instruction += "\n";
        instruction += "```\n";
        instruction += `subagent({\n`;
        instruction += `  agent: "worker",\n`;
        instruction += `  model: "${modelKey(synthesisModel)}",\n`;
        instruction += `  context: "fork",\n`;
        instruction += `  async: false,\n`;
        instruction += `  task: "<use synthesized fix direction here>",\n`;
        instruction += `  acceptance: {\n`;
        instruction += `    level: "verified",\n`;
        instruction += `    criteria: ["fix-is-implemented", "existing-tests-pass"],\n`;
        instruction += `    evidence: ["changed-files", "commands-run"],\n`;
        instruction += `    verify: [{ id: "tests-pass", command: "npm test" }]\n`;
        instruction += `  }\n`;
        instruction += `})\n`;
        instruction += "```\n";
      } else {
        instruction += "\n**Summary only — do not implement anything.**\n";
        instruction += "Produce: root cause, evidence from each model's investigation, confidence level assessment, and recommended fix direction.\n";
      }

      pi.sendUserMessage(instruction);
      ctx.ui.notify("MOA investigation launched", "info");
    },
  });
}
