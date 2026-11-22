export type Offence = { needle: string; count: number; firstLine: number };
export function absolutePathOffences(source: string, needles: string[]): Offence[];
export function bundleNeedles(input: { homeDir?: string; repoRoot?: string }): string[];
export function resolutionRootShared(input: {
  worktreeModules: string;
  mainModules: string;
  realpath?: (path: string) => string;
}): { worktreeReal: string } | null;
export function mainCheckoutFromCommonDir(gitCommonDir: string): string;
export function prebuildVerdict(input: {
  cwd: string;
  gitCommonDir: string | null;
  realpath?: (path: string) => string;
}): { ok: boolean; shared: { worktreeReal: string } | null; reason: string | null };
export function bundleVerdict(input: { source: string; homeDir?: string; repoRoot?: string }): {
  ok: boolean;
  offences: Offence[];
};
