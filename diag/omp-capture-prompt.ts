import { writeFileSync } from "node:fs";

// Load after prompt-mutating extensions to capture their final array unchanged.
export default function (pi: { on(event: string, handler: (event: any) => unknown): void }) {
  pi.on("before_agent_start", (event) => {
    const outputPath = process.env.OMP_CAPTURE_OUT;
    if (!outputPath) throw new Error("Set OMP_CAPTURE_OUT to the capture file path");
    writeFileSync(outputPath, JSON.stringify({ systemPrompt: event.systemPrompt }, null, 2) + "\n");
    return undefined;
  });
}
