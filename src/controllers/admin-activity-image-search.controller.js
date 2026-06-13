const imageSearchService = require('../services/admin-activity-image-search.service');

exports.search = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) {
      return res.status(400).json({ success: false, message: 'Query parameter q is required' });
    }

    const payload = await imageSearchService.searchActivityImages(q, {
      sources: req.query.sources,
      page: req.query.page,
      perPage: req.query.perPage,
    });

    return res.json({ success: true, data: payload.results, meta: payload.meta });
  } catch (err) {
    const status = Number(err?.status || 500);
    const message = String(err?.message || 'Unable to search images');
    return res.status(status).json({ success: false, message });
  }
};
