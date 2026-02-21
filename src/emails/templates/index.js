const renderWelcomeTemplate = require('./welcome.template');
const renderItineraryInviteTemplate = require('./itinerary-invite.template');

const templateRegistry = {
  welcome: renderWelcomeTemplate,
  itinerary_invite: renderItineraryInviteTemplate,
};

function renderEmailTemplate(templateKey, data = {}) {
  const renderer = templateRegistry[templateKey];
  if (!renderer) {
    throw new Error(`Email template "${templateKey}" not found.`);
  }
  return renderer(data);
}

module.exports = {
  renderEmailTemplate,
  templateRegistry,
};
