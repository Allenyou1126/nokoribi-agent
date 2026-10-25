/** Trim a configured string value; blank values are treated as absent. */
export function configuredValue(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
