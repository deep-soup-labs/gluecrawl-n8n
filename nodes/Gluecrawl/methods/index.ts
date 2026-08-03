/**
 * Dynamic-parameter methods, kept out of `resources/` because they are not an
 * operation: they run at edit time, from an `ILoadOptionsFunctions` context,
 * and never appear in the router's dispatch table.
 */

export { searchJobs, searchRuns } from './listSearch';
