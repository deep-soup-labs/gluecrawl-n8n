/**
 * The inline wait must stay opt-in on every operation that offers one.
 *
 * Job: Create and Run: Start both poll `/v1` in-process until the work is done.
 * That blocks the n8n execution for the whole duration — minutes, for a job
 * whose mapper runs three LLM agents before the first scrape even starts — and
 * on n8n Cloud an execution that outlives the plan's limit is killed with the
 * job still running and still billable, because `/v1` has no cancel endpoint.
 *
 * Defaulting the toggle to `true` therefore put the worst failure mode on the
 * path a user gets without touching anything. n8n stores only parameters the
 * user actually edited, so the default here is the live behaviour for every
 * workflow that left the toggle alone — which is exactly why a silent flip back
 * would be invisible in review. This test makes it loud.
 */

import type { INodeProperties } from 'n8n-workflow';

import { Gluecrawl } from '../../nodes/Gluecrawl/Gluecrawl.node';

const properties = new Gluecrawl().description.properties;

/** The operations that expose an inline wait, as `resource:operation`. */
const WAITING_OPERATIONS = ['job:create', 'run:start'];

function slugOf(property: INodeProperties): string {
	const show = property.displayOptions?.show;
	return `${String(show?.resource?.[0])}:${String(show?.operation?.[0])}`;
}

function propertiesNamed(name: string): INodeProperties[] {
	return properties.filter((property) => property.name === name);
}

function propertyOn(name: string, slug: string): INodeProperties | undefined {
	return propertiesNamed(name).find((property) => slugOf(property) === slug);
}

describe('inline wait defaults', () => {
	it('offers the wait on exactly the two long-running operations', () => {
		expect(propertiesNamed('waitForCompletion').map(slugOf)).toEqual(WAITING_OPERATIONS);
	});

	it.each(WAITING_OPERATIONS)('defaults Wait for Completion to off on %s', (slug) => {
		expect(propertyOn('waitForCompletion', slug)?.default).toBe(false);
	});

	it.each(WAITING_OPERATIONS)('shows Timeout only while waiting on %s', (slug) => {
		// A visible Timeout on a node that is not waiting is a control that does
		// nothing, and reads as though the request itself were being bounded.
		expect(propertyOn('timeout', slug)?.displayOptions?.show?.waitForCompletion).toEqual([true]);
	});
});
