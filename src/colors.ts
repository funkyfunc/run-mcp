import pc from "picocolors";

/**
 * Determine if colors should be enabled based on the Terminal Colors Evaluation Hierarchy:
 * 1. Command-line flag `--color=always` / `--color=never`
 * 2. Environment Variable `CLICOLOR_FORCE != 0`
 * 3. Environment Variable `NO_COLOR` present and non-empty -> disable color.
 * 4. Environment Variable `CLICOLOR == 0` -> disable color.
 * 5. Hardware `isatty` returns false -> disable color.
 * 6. Default (TTY is true) -> enable color.
 */
export function shouldEnableColor(): boolean {
  // 1. Flag: check command line args (before '--' terminator)
  const dashDashIdx = process.argv.indexOf("--");
  const argsToCheck = dashDashIdx === -1 ? process.argv : process.argv.slice(0, dashDashIdx);

  for (let i = 0; i < argsToCheck.length; i++) {
    const arg = argsToCheck[i];
    if (arg.startsWith("--color=")) {
      const val = arg.split("=")[1];
      if (val === "always") return true;
      if (val === "never") return false;
    } else if (arg === "--color") {
      const val = argsToCheck[i + 1];
      if (val === "always") return true;
      if (val === "never") return false;
    }
  }

  // 2. Env Var: CLICOLOR_FORCE != '0'
  if (process.env.CLICOLOR_FORCE !== undefined && process.env.CLICOLOR_FORCE !== "0") {
    return true;
  }

  // 3. Env Var: NO_COLOR is present and non-empty
  if (process.env.NO_COLOR) {
    return false;
  }

  // 4. Env Var: CLICOLOR == '0'
  if (process.env.CLICOLOR === "0") {
    return false;
  }

  // 5. Hardware: isatty returns false
  const isatty = !!(process.stdout?.isTTY || process.stderr?.isTTY);
  if (!isatty) {
    return false;
  }

  // 6. Default: TTY is true
  return true;
}

export const colors = pc.createColors(shouldEnableColor());
