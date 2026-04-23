/**
 * Slugify a string into a Docker/compose-friendly identifier.
 *
 * Rules:
 *   - Lowercase
 *   - Replace any run of non-alphanumeric chars with a single `-`
 *   - Trim leading/trailing `-`
 *   - Collapse to "cook-app" if the result is empty
 *   - Truncate to 63 chars (Docker container name limit)
 *
 * Used by the compose, dockerfile, and readme generators to derive image /
 * service / container names from a recipe's `name` field, and by various
 * places that need a stable identifier from an arbitrary URL or string.
 */
export function slugify(input: string, fallback = 'cook-app'): string {
  const out = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!out) return fallback;
  return out.length > 63 ? out.slice(0, 63).replace(/-+$/, '') : out;
}

/** Sanitize a value for use as a Docker build stage name.
 *  Stage names allow lowercase + digits + dashes + underscores; we
 *  normalize to dashes for consistency with `slugify`. */
export function stageName(input: string, prefix = ''): string {
  const slug = slugify(input);
  return prefix ? `${slugify(prefix)}-${slug}` : slug;
}
