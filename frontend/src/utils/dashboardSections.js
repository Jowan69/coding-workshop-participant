/** Element ids of the Dashboard's sections, in page order; summary tiles jump to them. */
export const SECTION_IDS = {
  projectStatus: 'project-status',
  atRisk: 'at-risk',
  allocation: 'allocation',
  deliverables: 'deliverables',
  overAllocated: 'over-allocated',
  dependencies: 'dependencies',
  budget: 'budget',
};

/**
 * The id of a section's heading, which a summary tile focuses to jump to the section.
 *
 * @param {string} sectionId One of SECTION_IDS.
 * @returns {string} The heading's element id.
 */
export function sectionHeadingId(sectionId) {
  return `${sectionId}-heading`;
}
