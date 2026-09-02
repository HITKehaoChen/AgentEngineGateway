import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const QuestionOption = Type.Object({
  label: Type.String({ description: "Visible option label" }),
  description: Type.Optional(Type.String({ description: "Optional explanation" })),
});

const QuestionParams = Type.Object({
  questions: Type.Array(Type.Object({
    question: Type.String({ description: "Question to show the user" }),
    options: Type.Array(QuestionOption),
  }), { minItems: 1 }),
});

const PermissionParams = Type.Object({
  permission: Type.String({ description: "Permission being requested" }),
  patterns: Type.Optional(Type.Array(Type.String())),
  message: Type.Optional(Type.String()),
});

/**
 * Production-only Pi bridge. It exposes user interaction as normal Pi tools;
 * the RPC adapter turns ctx.ui dialogs into Gateway Question/Permission events.
 * It deliberately contains no task-specific or Office behavior.
 */
export default function registerGatewayBridge(pi: ExtensionAPI): void {
  const permanentlyAllowed = new Set<string>();

  pi.registerTool({
    name: "question",
    label: "Ask user",
    description: "Ask the user one or more questions when the task needs a choice or missing information.",
    promptSnippet: "ask the user for a choice or missing information",
    parameters: QuestionParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) return result("Question cancelled: no interactive UI is available.");
      const answers: string[][] = [];
      for (const item of params.questions) {
        if (signal?.aborted) return result("Question cancelled.");
        const labels = item.options.map((option) => option.label);
        const answer = labels.length > 0
          ? await ctx.ui.select(item.question, labels, signal ? { signal } : undefined)
          : await ctx.ui.input(item.question, undefined, signal ? { signal } : undefined);
        if (answer === undefined) return result("Question cancelled by the user.");
        answers.push([answer]);
      }
      return result(`User answers: ${JSON.stringify(answers)}`);
    },
  });

  pi.registerTool({
    name: "permission",
    label: "Request permission",
    description: "Ask the user to approve or reject an operation before proceeding.",
    promptSnippet: "request user permission before a sensitive operation",
    parameters: PermissionParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) return result("Permission rejected: no interactive UI is available.");
      const grantKey = permissionGrantKey(params.permission, params.patterns ?? []);
      if (permanentlyAllowed.has(grantKey)) return result("Permission permanently approved by the user.");
      const patterns = params.patterns?.length ? ` [patterns: ${JSON.stringify(params.patterns)}]` : "";
      const choice = await ctx.ui.select(`Permission: ${params.permission}${patterns}`, ["Once", "Always", "Reject"], signal ? { signal } : undefined);
      if (choice === undefined || choice === "Reject") return result("Permission rejected by the user.");
      if (choice === "Always") permanentlyAllowed.add(grantKey);
      return result(choice === "Always" ? "Permission permanently approved by the user." : "Permission approved once by the user.");
    },
  });
}

function permissionGrantKey(permission: string, patterns: string[]): string {
  return JSON.stringify([permission, [...patterns].sort()]);
}

function result(text: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, never> } {
  return { content: [{ type: "text", text }], details: {} };
}
