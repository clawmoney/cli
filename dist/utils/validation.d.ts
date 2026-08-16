interface NumberBounds {
    defaultValue?: number;
    min?: number;
    max?: number;
}
export declare function parseIntegerOption(raw: string | undefined, flag: string, bounds?: NumberBounds): number;
export declare function parseNumberOption(raw: string | undefined, flag: string, bounds?: NumberBounds): number;
export declare function parseJsonObjectOption(raw: string, flag: string): Record<string, unknown>;
export {};
