/**
 * The trigger's Job filter is a picker, and a picker is two halves that have to
 * agree: a `resourceLocator` naming a `searchListMethod`, and a `methods.listSearch`
 * entry providing it. Either half alone type-checks and passes every other test
 * in this suite, while the editor renders a dropdown that can only fail to load.
 */

import type { INodePropertyMode } from 'n8n-workflow';

import { GluecrawlTrigger } from '../../nodes/GluecrawlTrigger/GluecrawlTrigger.node';

const trigger = new GluecrawlTrigger();

const jobField = trigger.description.properties.find((property) => property.name === 'jobId');

function listMode(modes: INodePropertyMode[] | undefined) {
	return modes?.find((mode) => mode.name === 'list');
}

describe('trigger: Job filter', () => {
	it('is a resource locator, not a free-text ID field', () => {
		expect(jobField?.type).toBe('resourceLocator');
	});

	it('is optional, so an unfiltered trigger stays configurable', () => {
		// `required: true` would make the editor demand a job before the node could
		// be saved, and "every job on the account" is the default use of a trigger.
		expect(jobField?.required).not.toBe(true);
		expect(jobField?.default).toEqual({ mode: 'list', value: '' });
	});

	it('offers both a list and a By ID mode', () => {
		expect((jobField?.modes ?? []).map((mode) => mode.name)).toEqual(['list', 'id']);
	});

	it('names a search method the node actually exposes', () => {
		const searchListMethod = listMode(jobField?.modes)?.typeOptions?.searchListMethod;

		expect(searchListMethod).toBe('searchJobs');
		expect(typeof trigger.methods.listSearch.searchJobs).toBe('function');
	});
});
