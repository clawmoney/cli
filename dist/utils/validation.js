import chalk from "chalk";
function failOption(flag, detail) {
    console.error(chalk.red(`Invalid ${flag}: ${detail}.`));
    process.exit(1);
}
function getOptionText(raw, flag, bounds) {
    if (raw == null) {
        if (bounds.defaultValue != null)
            return String(bounds.defaultValue);
        failOption(flag, "value is required");
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
        failOption(flag, "value cannot be empty");
    }
    return trimmed;
}
function enforceBounds(value, flag, bounds) {
    if (bounds.min != null && value < bounds.min) {
        failOption(flag, `must be at least ${bounds.min}`);
    }
    if (bounds.max != null && value > bounds.max) {
        failOption(flag, `must be at most ${bounds.max}`);
    }
}
export function parseIntegerOption(raw, flag, bounds = {}) {
    const text = getOptionText(raw, flag, bounds);
    if (!/^[+-]?\d+$/.test(text)) {
        failOption(flag, "must be an integer");
    }
    const value = Number(text);
    if (!Number.isSafeInteger(value)) {
        failOption(flag, "must be a safe integer");
    }
    enforceBounds(value, flag, bounds);
    return value;
}
export function parseNumberOption(raw, flag, bounds = {}) {
    const text = getOptionText(raw, flag, bounds);
    const value = Number(text);
    if (!Number.isFinite(value)) {
        failOption(flag, "must be a finite number");
    }
    enforceBounds(value, flag, bounds);
    return value;
}
export function parseJsonObjectOption(raw, flag) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        failOption(flag, 'must be valid JSON, for example \'{"prompt":"hello"}\'');
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        failOption(flag, "must be a JSON object");
    }
    return parsed;
}
