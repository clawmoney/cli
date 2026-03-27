export function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  fieldName: string,
  options: { min?: number; max?: number } = {}
): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  const min = options.min ?? 1;

  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < min) {
    throw new Error(`${fieldName} must be an integer greater than or equal to ${min}.`);
  }

  if (options.max !== undefined && parsed > options.max) {
    throw new Error(`${fieldName} must be less than or equal to ${options.max}.`);
  }

  return parsed;
}

export function parseNonNegativeNumber(value: string, fieldName: string): number {
  const parsed = Number.parseFloat(value);

  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`${fieldName} must be a non-negative number.`);
  }

  return parsed;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
