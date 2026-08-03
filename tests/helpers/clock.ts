/**
 * Virtual clock for the wait/poll paths.
 *
 * Jest's fake timers are the wrong tool here: the poll loop interleaves `sleep`
 * with real HTTP (nock intercepts `fetch`, whose response still arrives on a
 * real macrotask), and a faked timer queue starves that I/O — the loop stalls
 * and the test hangs. Instead the polling test files replace `sleep` with a
 * function that advances this counter and resolves immediately, and point
 * `Date.now` at the same counter.
 *
 * That makes elapsed time exact rather than approximate: it equals the sum of
 * the intervals the code under test asked to sleep for, so a timeout budget is
 * asserted against the numbers the node actually uses and nothing waits for
 * real.
 *
 * Because `jest.mock` is hoisted above the imports, every polling test file
 * needs this block at the very top of the file:
 *
 * ```ts
 * jest.mock('n8n-workflow', () => {
 *   const actual = jest.requireActual('n8n-workflow');
 *   const { virtualClock } = jest.requireActual('../helpers/clock');
 *   return {
 *     ...actual,
 *     sleep: async (ms: number) => {
 *       virtualClock.now += ms;
 *     },
 *   };
 * });
 * ```
 */

/** Arbitrary fixed epoch, so a failure quotes a stable timestamp. */
const EPOCH = Date.parse('2026-01-01T00:00:00.000Z');

/**
 * The shared counter. An object rather than a `let` binding so the hoisted
 * `jest.mock` factory can capture it before the test module body has run.
 */
export const virtualClock = { now: EPOCH };

/** Points `Date.now` at the virtual clock and rewinds it to the epoch. */
export function installVirtualClock(): void {
	virtualClock.now = EPOCH;
	jest.spyOn(Date, 'now').mockImplementation(() => virtualClock.now);
}

/** Restores the real `Date.now`. */
export function uninstallVirtualClock(): void {
	jest.spyOn(Date, 'now').mockRestore();
	virtualClock.now = EPOCH;
}

/** Virtual milliseconds burned since the clock was installed. */
export function virtualElapsedMs(): number {
	return virtualClock.now - EPOCH;
}
