export declare function parsePositiveInteger(value: string | undefined, fallback: number, fieldName: string, options?: {
    min?: number;
    max?: number;
}): number;
export declare function parseNonNegativeNumber(value: string, fieldName: string): number;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
