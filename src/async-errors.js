// Express 4 does not forward rejected promises from async handlers to the error middleware, which
// leaves the request hanging. Patch Layer so any async handler rejection reaches next(err).
import Layer from 'express/lib/router/layer.js';

const original = Layer.prototype.handle_request;
Layer.prototype.handle_request = function handle(req, res, next) {
  const fn = this.handle;
  if (fn.length > 3) return next(); // error-handling middleware: leave to express
  try {
    const out = fn(req, res, next);
    if (out && typeof out.catch === 'function') out.catch(next);
  } catch (e) { next(e); }
};
void original;
