/** Pathspecs excluded from the worker result snapshot and its active diff. */
export const RESULT_EXCLUDE_PATHS = [
  ":(exclude).broker-tmp",
  ":(exclude)*.bundle",
] as const;
