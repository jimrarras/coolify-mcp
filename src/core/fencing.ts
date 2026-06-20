import { err, ok } from "./errors.js";
import type { ToolResult } from "./errors.js";

export interface FenceContext {
  enableHostOps: boolean;
  allowDestructive: boolean;
}

export interface DestructiveArgs {
  confirm?: boolean;
  dry_run?: boolean;
}

/** Extracts the {confirm, dry_run} fence inputs from a tool handler's raw args. */
export function destructiveArgs(args: Record<string, unknown>): DestructiveArgs {
  return {
    confirm: args.confirm as boolean | undefined,
    dry_run: args.dry_run as boolean | undefined,
  };
}

export async function checkFences(
  ctx: FenceContext,
  opts: {
    destructive?: boolean;
    requireHostOps?: boolean;
    args: DestructiveArgs;
    preview?: () => Promise<unknown>;
  },
): Promise<ToolResult | null> {
  // 1. Host-ops fence (checked first)
  if (opts.requireHostOps && !ctx.enableHostOps) {
    return err(
      "host_ops_disabled",
      "This action requires --enable-host-ops to be set at startup.",
    );
  }

  // 2. Destructive fence
  if (opts.destructive) {
    if (!ctx.allowDestructive) {
      return err(
        "destructive_blocked",
        "This is a destructive action and --allow-destructive was not set at startup.",
      );
    }

    // 3. Dry-run (short-circuit before confirm check)
    if (opts.args.dry_run) {
      if (opts.preview) {
        const previewData = await opts.preview();
        return ok({ dry_run: true, preview: previewData });
      }
      return ok({ dry_run: true });
    }

    // 4. Confirm check
    if (!opts.args.confirm) {
      let rawResponse: unknown = undefined;
      if (opts.preview) {
        rawResponse = await opts.preview();
      }
      return err(
        "confirmation_required",
        "This is a destructive action. Pass confirm:true to proceed.",
        rawResponse,
      );
    }
  }

  return null;
}
