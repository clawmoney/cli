interface SubmitOptions {
    url: string;
    text?: string;
}
interface VerifyOptions {
    witness?: boolean;
}
export declare function hireSubmitCommand(taskId: string, options: SubmitOptions): Promise<void>;
export declare function hireVerifyCommand(taskId: string, options: VerifyOptions): Promise<void>;
export {};
