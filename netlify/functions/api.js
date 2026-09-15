const serverless = require("serverless-http");
const { server } = require("../../server");

const serve = serverless(server);

exports.handler = (event, context) => {
  // Redirects send API requests through this function. Restore the original
  // application path before passing it to the existing Node HTTP server.
  const prefix = "/.netlify/functions/api";
  const path = event.path.startsWith(prefix)
    ? `/api${event.path.slice(prefix.length)}`
    : event.path;
  return serve({ ...event, path }, context);
};
