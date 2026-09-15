const { server } = require("../server");

// Adapt the existing Node HTTP server to Vercel's request-based function API.
module.exports = (req, res) => server.emit("request", req, res);
