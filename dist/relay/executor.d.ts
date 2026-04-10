import type { ParsedOutput } from "./types.js";
export declare function ensureEmptyMcpConfig(): string;
export declare function ensureSandboxDir(): string;
export declare function spawnCli(cliType: string, args: string[], timeoutMs?: number, cwd?: string): Promise<string>;
export declare function buildCliArgs(cliType: string, prompt: string, sessionId?: string, maxBudgetUsd?: number, model?: string): string[];
export declare function parseClaudeOutput(raw: string): ParsedOutput;
export declare function parseCodexOutput(raw: string): ParsedOutput;
export declare function parseGeminiOutput(raw: string): ParsedOutput;
export declare function parseCliOutput(cliType: string, raw: string): ParsedOutput;
