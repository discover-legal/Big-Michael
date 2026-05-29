import Anthropic from "@anthropic-ai/sdk";
import { v4 as uuidv4 } from "uuid";
import { Config } from "../config.js";
import { logger } from "../logger.js";
import { selectModel, estimateComplexity, ModelLabels } from "../routing/model.js";
import type {
  AgentDefinition,
  AgentMessage,
  Finding,
  Citation,
  NeedDescriptor,
  OfferDescriptor,
  RoundGoal,
  MemoryEntry,
} from "../types.js";

const anthropic = new Anthropic({ apiKey: Config.anthropic.apiKey });

export interface AgentContext {
  roundGoal: RoundGoal;
  /** Messages routed to this agent via the DyTopo communication graph */
  incomingMessages: AgentMessage[];
  /** Inter-round memory entries retrieved for this agent */
  memoryEntries: MemoryEntry[];
  /** Task description for grounding */
  taskDescription: string;
}

export class Agent {
  readonly definition: AgentDefinition;

  constructor(definition: AgentDefinition) {
    this.definition = definition;
  }

  /**
   * Generate Need/Offer descriptors — always uses Haiku (lightweight, per-round, many calls).
   */
  async generateNeedOffer(ctx: AgentContext): Promise<{
    need: NeedDescriptor;
    offer: OfferDescriptor;
  }> {
    const model = selectModel({
      tier: this.definition.tier,
      type: this.definition.type,
      taskType: "descriptor",  // always Haiku
    });
    const prompt = buildNeedOfferPrompt(this.definition, ctx);
    const response = await this.callClaude(prompt, 200, model);
    return parseNeedOffer(response, this.definition.id);
  }

  /**
   * Process round context and produce findings.
   * Model selected based on tier + task type + estimated complexity.
   */
  async process(ctx: AgentContext): Promise<Finding[]> {
    const taskType = inferTaskType(this.definition);
    const complexity = estimateComplexity(ctx.roundGoal.description);

    const model = selectModel({
      tier: this.definition.tier,
      type: this.definition.type,
      taskType,
      complexity,
    });

    const prompt = buildProcessingPrompt(this.definition, ctx);
    const maxTokens = this.definition.tier === 3 ? 600 : this.definition.tier === 0 ? 4000 : 2500;

    logger.debug("Agent processing", {
      agent: this.definition.name,
      model: ModelLabels[model] ?? model,
      taskType,
      complexity,
    });

    const response = await this.callClaude(prompt, maxTokens, model);
    return parseFindings(response, this.definition);
  }

  private async callClaude(
    userMessage: string,
    maxTokens: number,
    model: string,
  ): Promise<string> {
    const msg = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      system: this.definition.systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });
    const block = msg.content[0];
    if (block.type !== "text") throw new Error("Unexpected content type from Claude");
    return block.text;
  }
}

// ─── Task type inference ──────────────────────────────────────────────────────

function inferTaskType(def: AgentDefinition): import("../routing/model.js").TaskType {
  if (def.tier === 3) return "extraction";
  if (def.id.includes("drafter") || def.id.includes("writer")) return "drafting";
  if (def.id.includes("analyst") || def.id.includes("agent")) return "reasoning";
  if (def.type === "root") return "synthesis";
  if (def.type === "manager") return "routing";
  return "reasoning";
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildNeedOfferPrompt(def: AgentDefinition, ctx: AgentContext): string {
  return `TASK: ${ctx.taskDescription}

CURRENT ROUND GOAL (Round ${ctx.roundGoal.round}, Phase: ${ctx.roundGoal.phase}):
${ctx.roundGoal.description}

YOUR ROLE: ${def.name} — ${def.description}

RELEVANT MEMORY FROM PRIOR ROUNDS:
${ctx.memoryEntries.length ? ctx.memoryEntries.map((e) => `[Round ${e.round}] ${e.content}`).join("\n") : "None yet."}

Output exactly:
NEED: <one sentence — what information or expertise you currently need from other agents>
OFFER: <one sentence — what you can contribute this round given your role>`;
}

function buildProcessingPrompt(def: AgentDefinition, ctx: AgentContext): string {
  const incoming = ctx.incomingMessages.length
    ? ctx.incomingMessages
        .map((m) => `[FROM: ${m.from}]\n${m.content}`)
        .join("\n\n---\n\n")
    : "No messages routed to you this round.";

  const memory = ctx.memoryEntries.length
    ? ctx.memoryEntries.map((e) => `[Round ${e.round} — ${e.phase}] ${e.content}`).join("\n")
    : "No prior memory.";

  return `TASK: ${ctx.taskDescription}

ROUND GOAL (Round ${ctx.roundGoal.round} — Phase: ${ctx.roundGoal.phase}):
${ctx.roundGoal.description}

EXPECTED OUTPUTS THIS ROUND:
${ctx.roundGoal.expectedOutputs.map((o, i) => `${i + 1}. ${o}`).join("\n")}

INTER-ROUND MEMORY (what has been established in prior rounds):
${memory}

MESSAGES ROUTED TO YOU THIS ROUND (from other agents whose offers matched your needs):
${incoming}

────────────────────────────────────────────────────────────────
Produce your findings. For each distinct finding:

FINDING:
Content: <finding — state your conclusion or analysis clearly>
Citation: SOURCE=<document ID or URL or case ECLI> | QUOTE=<verbatim text> | PAGE=<page/para if known>
Confidence: <0.0–1.0>
END_FINDING

Rules:
- Each finding must have at least one Citation.
- Quote must be verbatim — not paraphrased.
- Multiple Citations allowed per finding (repeat Citation: lines).
- If you have no findings this round: NO_FINDINGS`;
}

// ─── Response parsers ─────────────────────────────────────────────────────────

function parseNeedOffer(
  text: string,
  agentId: string,
): { need: NeedDescriptor; offer: OfferDescriptor } {
  const needMatch = text.match(/NEED:\s*(.+)/i);
  const offerMatch = text.match(/OFFER:\s*(.+)/i);
  return {
    need: { agentId, text: needMatch?.[1]?.trim() ?? "No specific need this round." },
    offer: { agentId, text: offerMatch?.[1]?.trim() ?? "General domain expertise available." },
  };
}

function parseFindings(text: string, def: AgentDefinition): Finding[] {
  if (/NO_FINDINGS/i.test(text)) return [];

  const blocks = text.split(/FINDING:/gi).slice(1);
  const findings: Finding[] = [];

  for (const block of blocks) {
    const end = block.indexOf("END_FINDING");
    const body = end >= 0 ? block.slice(0, end) : block;

    const contentMatch = body.match(/Content:\s*([\s\S]+?)(?=Citation:|Confidence:|END_FINDING|$)/i);
    const citationMatches = [
      ...body.matchAll(
        /Citation:\s*SOURCE=(.+?)\s*\|\s*QUOTE=(.+?)(?:\s*\|\s*PAGE=(.+?))?(?=\nCitation:|\nConfidence:|END_FINDING|$)/gis,
      ),
    ];
    const confidenceMatch = body.match(/Confidence:\s*([\d.]+)/i);

    const content = contentMatch?.[1]?.trim();
    if (!content) continue;

    const citations: Citation[] = citationMatches.map((m) => ({
      source: m[1].trim(),
      quote: m[2].trim(),
      page: m[3] ? parseInt(m[3].trim()) : undefined,
      mechanicallyVerified: false,
    }));

    findings.push({
      id: uuidv4(),
      agentId: def.id,
      agentName: def.name,
      content,
      citations,
      confidence: parseFloat(confidenceMatch?.[1] ?? "0.7"),
      challenged: false,
      resolved: false,
      round: 0, // caller sets this
      timestamp: new Date(),
    });
  }

  return findings;
}
