export type PreparedCli = {
  args: string[];
  env: Record<string, string>;
};

export type CliRoots = {
  userData: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
};
