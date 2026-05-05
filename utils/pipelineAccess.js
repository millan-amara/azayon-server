const Pipeline = require('../models/Pipeline');

// Returns a Mongo filter fragment that restricts a query to pipelines the
// user is allowed to see. Admins always pass — they manage visibility, so
// they need every pipeline in their pickers. For non-admins, public ones
// (visibility='org') OR restricted ones where they're explicitly listed.
//
// Use as `{ ...baseFilter, ...pipelineVisibilityFilter(user) }` on Pipeline
// queries, or as the basis for a deal filter via getAllowedPipelineIds.
const pipelineVisibilityFilter = (user) => {
  if (user.role === 'admin') return {};
  return {
    $or: [
      { visibility: { $ne: 'restricted' } }, // covers 'org' and any legacy doc missing the field
      { visibility: 'restricted', allowedUsers: user._id },
    ],
  };
};

// Resolves to an array of pipeline ObjectIds the user can see. Use this when
// you need to filter a *deal* query by pipeline — e.g. `Deal.find({ pipeline:
// { $in: ids } })`. Admins get all pipeline IDs in the org.
const getAllowedPipelineIds = async (user, orgId) => {
  const filter = { orgId, ...pipelineVisibilityFilter(user) };
  const pipelines = await Pipeline.find(filter).select('_id').lean();
  return pipelines.map((p) => p._id);
};

// Boolean check for a single pipeline doc the caller already has in hand.
// Saves a round-trip when you've just fetched the pipeline by id.
const userCanAccessPipeline = (user, pipeline) => {
  if (!pipeline) return false;
  if (user.role === 'admin') return true;
  if (pipeline.visibility !== 'restricted') return true;
  return (pipeline.allowedUsers || []).some(
    (id) => id.toString() === user._id.toString()
  );
};

module.exports = {
  pipelineVisibilityFilter,
  getAllowedPipelineIds,
  userCanAccessPipeline,
};
