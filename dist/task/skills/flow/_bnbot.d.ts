export interface FlowVideoGenerateArgs {
    prompt: string;
    aspect?: string;
    duration?: number;
    count?: number;
    model?: string;
    images?: string[];
    response_format?: string;
    timeout?: number;
    project?: string;
}
export declare function bnbotFlowVideoGenerate(input: FlowVideoGenerateArgs): Promise<unknown>;
export interface FlowImageGenerateArgs {
    prompt: string;
    aspect?: string;
    count?: number;
    model?: string;
    images?: string[];
    response_format?: string;
    timeout?: number;
    project?: string;
}
export declare function bnbotFlowImageGenerate(input: FlowImageGenerateArgs): Promise<unknown>;
