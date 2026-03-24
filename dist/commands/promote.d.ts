interface SubmitOptions {
    url: string;
    platform?: string;
    text?: string;
}
interface VerifyOptions {
    witness?: boolean;
    relevance: string;
    quality: string;
    vote?: string;
}
export declare function promoteSubmitCommand(taskId: string, options: SubmitOptions): Promise<void>;
export declare function promoteVerifyCommand(submissionId: string, options: VerifyOptions): Promise<void>;
export {};
