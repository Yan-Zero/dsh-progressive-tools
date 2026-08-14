/**
 * Package-owned invariant companion for dsh-progressive-tools.
 * @module dsh-progressive-tools/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-progressive-tools'

/** Cordis companion plugin name. */
export const name = 'progressive-tools-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package owns no state or event relation. Its two
 * registrations and assembly listener are ordinary Cordis effects, while
 * ToolRuntime remains the sole visibility and execution authority.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
