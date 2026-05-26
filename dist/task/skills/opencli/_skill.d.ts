import type { SkillHandler } from "../../types.js";
type Input = Record<string, unknown>;
export declare function makeOpenCliSkill(label: string, runner: (input: Input) => Promise<unknown>, price?: number): SkillHandler;
export declare function str(input: Input, names: string[]): string | undefined;
export declare function reqStr(input: Input, names: string[], label?: string): string;
export declare function num(input: Input, names: string[]): number | undefined;
export {};
